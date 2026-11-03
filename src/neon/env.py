"""Ladda pappa:s env-variabler från .env.local (fallback .env).

Miljövariabler som redan är satta vinner över filen - samma regel som
src/neon/env.sh. Neon CLI:er skriver .env.local i den här katalogen med
DATABASE_URL (poolad) och DATABASE_URL_UNPOOLED (direkt).
"""
from __future__ import annotations

import os
from pathlib import Path

NEON_DIR = Path(__file__).resolve().parent
REPO_ROOT = NEON_DIR.parent.parent
ENV_FILES = (
    NEON_DIR / ".env.local",
    NEON_DIR / ".env",
    REPO_ROOT / ".env",
)


def load_env() -> None:
    """Ladda env-filen om DATABASE_URL inte redan är satt i miljön."""
    if os.environ.get("DATABASE_URL"):
        return

    for path in ENV_FILES:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if not key.isidentifier() or key in os.environ:
                continue
            os.environ[key] = value
        return


def direct_database_url() -> str:
    """Omedelbar (icke-poolad) URL - för migrationer, dump och restore."""
    return os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL", "")
