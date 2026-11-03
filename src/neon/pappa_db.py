"""Anslutning till pappa-databasen (Neon/Lakebase Postgres).

Driver: psycopg 3. Projektet har ingen ORM - psycopg behålls som det är.

Neon exponerar två endpoints för samma databas:

  poolad  (-pooler i hostnamen, PgBouncer i transaktionsläge)
          -> normal frågetrafik. Klienten kan komma till en annan
          server-session mellan transaktioner.
  direkt  (utan -pooler)
          -> migrationer, pg_dump/pg_restore, sessionsbunden SQL.

Mot den poolade endpointen stängs psycopgs prepared statements av
(prepare_threshold=None). psycopg avslutar prepared statements med
SQL-nivå DEALLOCATE, vilket PgBouncer inte stödjer, och en klient
session kan byta server-session mellan transaktioner. För en
datapipeline med några tusen rader kostar det inget att stänga av dem.
Den direkta endpointen körs med psycopgs default (där är prepared
statements korrekta och snabbare).
"""
from __future__ import annotations

import os
import sys
import time
from collections.abc import Callable
from typing import TypeVar
from urllib.parse import parse_qs, urlparse

import psycopg

from env import direct_database_url, load_env

T = TypeVar("T")

# Fel som betyder "försök igen": nätverk, kallstart, serialisering.
TRANSIENT_SQLSTATES = frozenset({
    "08000",  # connection_exception
    "08003",  # connection_does_not_exist
    "08006",  # connection_failure
    "08001",  # sqlclient_unable_to_establish_sqlconnection
    "40001",  # serialization_failure
    "40P01",  # deadlock_detected
    "53300",  # too_many_connections
    "57P01",  # admin_shutdown
    "57P02",  # crash_shutdown
    "57P03",  # cannot_connect_now
})

# Felmeddelanden som betyder "försök igen", trots att de inte är
# OperationalError (t.ex. gammal plan-cache efter DDL).
TRANSIENT_MARKERS = (
    "cache lookup failed for type",  # gammal plan-cache efter schemaändring
    "the database system is starting up",  # scale-to-zero kallstart
    "the database system is in recovery mode",
    "terminating connection due to administrator command",
    "server closed the connection unexpectedly",
    "SSL connection has been closed",
    "connection is closed",
    "could not connect",
)


def is_pooled(url: str) -> bool:
    """True om URL:en pekar på Neons PgBouncer-endpoint."""
    return "-pooler." in url


def sslmode_for(url: str) -> str | None:
    """sslmode att tvinga fram, eller None för att lämna URL:en ifred.

    Neons URL har sslmode=require. I libpq betyder det "kryptera men
    kontrollera inte certifikatet" - tillräckligt för att skydda
    personuppgifter i transit, men inte för att veta att vi pratar med
    rätt server. 'verify-full' kontrollerar dessutom certifikat och
    värdnamn, så vi kan bevisa vem vi talar med.

    Lokal docker-compose-databas saknar TLS - där lämnas URL:ens värde.
    """
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return None
    mode = (parse_qs(parsed.query).get("sslmode") or [""])[0]
    if mode in {"disable", "verify-full"}:
        return None
    return "verify-full"


# CA-buntar att prova för certifikatkontroll. libpq hittar inte systemets
# CA-rotar på egen ("system" är inte bärbart), så vi pekar ut en fil.
CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
)


def ssl_options(url: str) -> dict[str, str]:
    """TLS-inställningar för anslutningen.

    Returnerar t.ex. {'sslmode': 'verify-full', 'sslrootcert': '/etc/ssl/...'}
    när vi kan verifiera certifikatet, annars {} (URL:ens eget sslmode gäller).
    """
    if sslmode_for(url) is None:
        return {}
    root = os.environ.get("PAPPA_SSLROOTCERT") or next(
        (p for p in CA_BUNDLES if os.path.isfile(p)), ""
    )
    if not root:
        return {}
    return {"sslmode": "verify-full", "sslrootcert": root}


def database_url(*, direct: bool = False) -> str:
    """URL:en att använda - laddar .env.local/.env vid behov."""
    load_env()
    url = direct_database_url() if direct else os.environ.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("Saknar DATABASE_URL (eller --database-url)")
    return url


def connect(url: str | None = None, **kwargs):
    """Öppna en anslutning mot pappa-databasen."""
    url = url or database_url()
    if is_pooled(url):
        kwargs.setdefault("prepare_threshold", None)
    for key, value in ssl_options(url).items():
        kwargs.setdefault(key, value)
    kwargs.setdefault("connect_timeout", 15)
    return psycopg.connect(url, **kwargs)


def is_transient(exc: BaseException) -> bool:
    """True om felet är tillfälligt och värd att försöka om."""
    if isinstance(exc, psycopg.OperationalError):
        return True
    if getattr(exc, "sqlstate", None) in TRANSIENT_SQLSTATES:
        return True
    message = str(exc)
    return any(marker in message for marker in TRANSIENT_MARKERS)


def retry(fn: Callable[[], T], *, attempts: int = 3, delay: float = 2.0) -> T:
    """Kör fn igen vid tillfälliga fel (nätverk, kallstart, stale plan-cache).

    Används bara för idempotent arbete - importen är idempotent, så en
    omkörning är säker.
    """
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - fångar psycopg + SystemExit
            if attempt == attempts or not is_transient(exc):
                raise
            wait = delay * (2 ** (attempt - 1))
            print(
                f"[retry] tillfälligt fel ({type(exc).__name__}: "
                f"{str(exc).splitlines()[0]}) - försöker igen om {wait:g}s "
                f"(försök {attempt}/{attempts})",
                file=sys.stderr,
            )
            time.sleep(wait)
    raise AssertionError("unreachable")
