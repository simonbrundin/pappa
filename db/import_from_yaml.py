#!/usr/bin/env python3
"""
pappa - Importera frölistan (YAML) till masterdatabasen.

Skriver:
  - organization, person, person_employment, competence, person_competence,
    source, person_source
  - watchlist "standard" (er Teams-bevakningslista) med alla importerade personer

Kör:
  uv run --with "psycopg[binary]" --with pyyaml python db/import_from_yaml.py \
      --file data/sundsvall-it-people.yaml

Anslutning: läser DATABASE_URL ur miljön, eller ur .env.local/.env i
repo-roten (dit Neon CLI:er skriver den poolade URL:en). Använd
--database-url för att peka om.

Flaggor:
  --dry-run              Visa planen, skriv inte till DB
  --watchlist NAME       Namn på bevakningslistan (default: standard)
  --retention-months 6
  --no-watchlist         Skapa inte bevakningslista
  --employment-file PATH Anställningshistorik (default: data/employment-history.yaml)
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover
    sys.exit("psycopg saknas -> kör: uv run --with 'psycopg[binary]' --with pyyaml ...")

# Neon-lagret ligger i src/neon/ - lägg det på sys.path för importen.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "neon"))

from env import load_env  # noqa: E402
from pappa_db import connect, retry  # noqa: E402


# ---------------------------------------------------------------------------
# Normalisering
# ---------------------------------------------------------------------------
def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: str | None) -> str:
    if not s:
        return ""
    s = _strip_accents(s).lower()
    s = re.sub(r"\b(ab|hb|kb|as|oy|gmbh|aktiebolag)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_name(full: str) -> tuple[str | None, str | None]:
    parts = [p for p in full.split() if p]
    if len(parts) < 2:
        return (full or None, None)
    return (parts[0], " ".join(parts[1:]))


# Org-typ: YAML:s korta former -> DB-ens enum
ORG_KIND = {
    "privat": "consultancy",
    "consultancy": "consultancy",
    "konsult": "consultancy",
    "offentlig": "public_sector",
    "public_sector": "public_sector",
    "stat": "public_sector",
    "kommun": "public_sector",
    "region": "public_sector",
    "akademi": "academia",
    "universitet": "academia",
    "högskola": "academia",
    "industri": "industry",
    "bygg": "industry",
    "leverantör": "vendor",
    "vendor": "vendor",
    "annan": "other",
    "other": "other",
}

SOURCE_KIND = {
    "org_website": "company_site",
    "company_site": "company_site",
    "linkedin_public": "profile",
    "profile": "profile",
    "conference": "conference",
    "community": "community",
    "press": "press",
    "public_record": "public_record",
    "register": "register",
    "manual": "manual",
    "other": "other",
}

# ---------------------------------------------------------------------------
# Erfarenhet (år i IT)
#
# Databasen har ingen direktuppgift om hur länge någon arbetat med IT, så
# värdet härleds i tre steg, i prioritetsordning:
#
#   1. explicit  - it_experience_years i YAML (källbelagd)
#   2. notes     - "34 års erfarenhet" i notes-texten (källbelagd)
#   3. seniority - undre gräns utifrån rollnivå (gissning, inte källa)
#
# Steg 3 är en konservativ undre gräns: en 'senior' antas ha minst 5 år.
# Den är ett filter - inte ett facit - och grundens sparas i
# it_experience_basis så att det går att se vad som är källa och vad som är
# gissning. Okänt (None) får aldrig räknas som "3+ år".
# ---------------------------------------------------------------------------
SENIORITY_YEARS = {
    "cxo": 10,
    "chef": 10,
    "lead": 6,
    "senior": 5,
    "mid": 3,
    "junior": 0,
}

# "34 års erfarenhet", "30+ år i IT", "18 år på Sogeti"
YEARS_PATTERN = re.compile(r"(\d{1,2})\s*\+?\s*år(?:s|ar)?\b", re.IGNORECASE)


def it_experience(person: dict) -> tuple[int | None, str | None]:
    """(år i IT, grund) för en person - None/None när uppgiften saknas.

    'documented' sätts inte här - den kräver att anställningshistoriken
    redan är importerad och beräknas därefter i _apply_documented_experience().
    """
    explicit = person.get("it_experience_years")
    if isinstance(explicit, int) and explicit >= 0:
        return explicit, "explicit"

    notes = person.get("notes") or ""
    years = [int(y) for y in YEARS_PATTERN.findall(notes)]
    if years:
        return max(years), "notes"

    level = (person.get("seniority") or "").lower()
    if level in SENIORITY_YEARS:
        return SENIORITY_YEARS[level], "seniority"

    return None, None


# ---------------------------------------------------------------------------
# Anställningshistorik (CV-format)
# ---------------------------------------------------------------------------
DATE_FORMATS = ("%Y-%m-%d", "%Y-%m", "%Y")


def parse_date(value) -> date | None:
    """'2018', '2018-03' eller '2018-03-15' -> date. None = okänt."""
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"okänt datumformat: {value!r}")


def _resolve_org(cur, name: str, org_ids: dict[str, uuid], kind: str | None = None) -> uuid | None:
    if not name:
        return None
    nn = norm(name)
    if nn not in org_ids:
        cur.execute(
            "insert into organization (name, normalized_name, kind) values (%s,%s,%s) "
            "on conflict (normalized_name) do update set "
            "  kind = coalesce(organization.kind, excluded.kind), "
            "  updated_at = now() returning id",
            (name, nn, ORG_KIND.get(kind or "", None)),
        )
        org_ids[nn] = cur.fetchone()["id"]
    else:
        # Org som redan finns kan sakna kind (t.ex. skapad ur employers_to_work
        # där sektorn inte är en org_type). Fyll bara luckor - befintlig kind
        # skrivs aldrig över.
        mapped = ORG_KIND.get(kind or "", None)
        if mapped:
            cur.execute(
                "update organization set kind = %s, updated_at = now() "
                "where id = %s and kind is null",
                (mapped, org_ids[nn]),
            )
    return org_ids[nn]


def _resolve_source(cur, url: str, src_ids: dict[str, uuid], kind: str = "manual",
                    title: str | None = None) -> uuid | None:
    if not url:
        return None
    if url not in src_ids:
        cur.execute(
            "insert into source (url, title, kind) values (%s,%s,%s) "
            "on conflict (url) do update set title = coalesce(excluded.title, source.title) "
            "returning id",
            (url, title, SOURCE_KIND.get(kind, "other")),
        )
        src_ids[url] = cur.fetchone()["id"]
    return src_ids[url]


def _import_employment(cur, path: str, src_ids: dict[str, uuid],
                       org_ids: dict[str, uuid]) -> int:
    """Importerar data/employment-history.yaml - anställningshistorik i CV-format.

    Varje rad upsertas på (person_id, ref) så att en omkörning uppdaterar i
    stället för att duplicera.
    """
    if not Path(path).exists():
        return 0
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh) or {}

    count = 0
    # Poster som slagits ihop med en annan (fn_merge_people) ska inte skapa
    # tillbaka sig - de hör till den post som behålls.
    cur.execute("select dropped_external_id, keep_person_id from person_merge")
    merged = {row["dropped_external_id"]: row["keep_person_id"] for row in cur.fetchall()}

    for entry in doc.get("people", []) or []:
        person_ref = entry.get("id")
        if not person_ref:
            continue
        if person_ref in merged:
            cur.execute("select external_id from person where id = %s", (merged[person_ref],))
            kept = cur.fetchone()
            print(f"  info: '{person_ref}' är sammanslagen med "
                  f"'{kept['external_id'] if kept else merged[person_ref]}' - hoppas över")
            continue
        cur.execute("select id from person where external_id = %s", (person_ref,))
        row = cur.fetchone()
        if not row:
            print(f"  varning: anställningshistorik för okänd person '{person_ref}' - hoppas över")
            continue
        person_id = row["id"]

        for job in entry.get("employment", []) or []:
            ref = job.get("ref")
            if not ref:
                print(f"  varning: anställningsrad utan ref för {person_ref} - hoppas över")
                continue

            org_id = _resolve_org(cur, job.get("org", ""), org_ids, job.get("org_type"))
            source_id = _resolve_source(cur, job.get("source", ""), src_ids,
                                        job.get("source_type", "manual"), job.get("source_title"))
            valid_from = parse_date(job.get("from"))
            valid_to = parse_date(job.get("to"))
            is_current = bool(job.get("current"))
            stack = job.get("stack") or []
            confidence = job.get("confidence", "medium")

            cur.execute(
                "select id from person_employment where person_id = %s and ref is null and is_current limit 1",
                (person_id,),
            )
            legacy = cur.fetchone()
            if legacy:
                # Legacy-raden (utan ref) adopteras av den kuraterade raden,
                # så en person inte får två "aktuella" anställningar.
                cur.execute(
                    """
                    update person_employment
                    set ref = %s, organization_id = %s, title = %s,
                        valid_from = %s, valid_to = %s, source_id = %s, note = %s,
                        employment_type = %s, seniority = %s, confidence = %s, stack = %s
                    where id = %s
                    """,
                    (ref, org_id, job.get("title"), valid_from, valid_to, source_id,
                     job.get("note"), job.get("type"), job.get("seniority"), confidence,
                     stack, legacy["id"]),
                )
                employment_id = legacy["id"]
            else:
                cur.execute(
                    """
                    insert into person_employment
                        (person_id, organization_id, title, is_current, valid_from, valid_to,
                         source_id, note, ref, employment_type, seniority, confidence, stack)
                    values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    on conflict (person_id, ref) where ref is not null do update
                      set organization_id = excluded.organization_id,
                          title           = excluded.title,
                          is_current      = excluded.is_current,
                          valid_from      = excluded.valid_from,
                          valid_to        = excluded.valid_to,
                          source_id       = excluded.source_id,
                          note            = excluded.note,
                          employment_type = excluded.employment_type,
                          seniority       = excluded.seniority,
                          confidence      = excluded.confidence,
                          stack           = excluded.stack
                    returning id
                    """,
                    (person_id, org_id, job.get("title"), is_current, valid_from, valid_to,
                     source_id, job.get("note"), ref, job.get("type"), job.get("seniority"),
                     confidence, stack),
                )
                employment_id = cur.fetchone()["id"]
            count += 1

            for tag in stack:
                cur.execute(
                    "insert into competence (tag) values (%s) on conflict (tag) do nothing",
                    (tag,),
                )
                cur.execute(
                    "insert into employment_competence (employment_id, competence_id) "
                    "select %s, c.id from competence c where c.tag = %s "
                    "on conflict do nothing",
                    (employment_id, tag),
                )
            if stack:
                cur.execute(
                    "delete from employment_competence ec using competence c "
                    "where ec.competence_id = c.id and ec.employment_id = %s "
                    "and not (c.tag = any(%s))",
                    (employment_id, stack),
                )
    return count


def _apply_documented_experience(cur) -> int:
    """Sätter it_experience_years ur daterad anställningshistorik.

    Överskriver bara gissade värden ('seniority') eller tomma - aldrig
    'explicit'/'notes'/'documented'.
    """
    cur.execute(
        """
        update person p
        set it_experience_years = m.years,
            it_experience_basis = 'documented'
        from (
          select person_id, floor(fn_documented_experience(person_id) / 12.0)::int as years
          from person_employment
          group by person_id
        ) m
        where p.id = m.person_id
          and m.years > 0
          and (p.it_experience_basis is null or p.it_experience_basis = 'seniority')
        """
    )
    return cur.rowcount


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="data/sundsvall-it-people.yaml")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--watchlist", default="standard")
    ap.add_argument("--watchlist-owner", default=os.environ.get("WATCHLIST_OWNER", ""))
    ap.add_argument("--retention-months", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-watchlist", action="store_true")
    ap.add_argument("--employment-file", default="data/employment-history.yaml")
    args = ap.parse_args()

    if not args.database_url:
        sys.exit("Saknar DATABASE_URL (eller --database-url)")

    with open(args.file, encoding="utf-8") as fh:
        raw = fh.read()
    doc = yaml.safe_load(raw)
    sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()

    people = doc.get("people", [])
    employers = doc.get("employers_to_work", [])
    sources = doc.get("sources", [])
    taxonomy = doc.get("competence_taxonomy", {}) or {}

    if args.dry_run:
        print(f"[dry-run] {args.file}  sha256={sha[:12]}  {len(people)} personer, "
              f"{len(employers)} arbetsgivare, {len(sources)} källor")
        return 0

    retention = date.today() + timedelta(days=30 * args.retention_months)

    with connect(args.database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            run = cur.execute(
                "insert into import_run (source_file, source_sha, note) "
                "values (%s,%s,%s) returning id",
                (args.file, sha, f"import {len(people)} personer"),
            ).fetchone()

            # --- organisationer -------------------------------------------
            org_ids: dict[str, uuid] = {}
            for e in employers:
                name = e.get("org")
                if not name:
                    continue
                nn = norm(name)
                cur.execute(
                    """
                    insert into organization (name, normalized_name, kind, city, employees, notes)
                    values (%s,%s,%s,%s,%s,%s)
                    on conflict (normalized_name) do update
                      set employees = coalesce(excluded.employees, organization.employees),
                          notes     = coalesce(organization.notes, excluded.notes),
                          updated_at = now()
                    returning id
                    """,
                    (name, nn, ORG_KIND.get(e.get("sector") or e.get("org_type", ""), None),
                     e.get("site"), e.get("employees"), e.get("note")),
                )
                org_ids[nn] = cur.fetchone()["id"]

            # --- källor ----------------------------------------------------
            src_ids: dict[str, uuid] = {}
            for s in sources:
                url = s.get("url")
                if not url:
                    continue
                cur.execute(
                    """
                    insert into source (url, title, kind, note)
                    values (%s,%s,%s,%s)
                    on conflict (url) do update set title = coalesce(excluded.title, source.title)
                    returning id
                    """,
                    (url, s.get("used_for"), SOURCE_KIND.get(s.get("type", "other"), "other"),
                     s.get("type")),
                )
                src_ids[url] = cur.fetchone()["id"]

            # --- kompetensordbok ------------------------------------------
            # Ordboken är kategori -> [taggar]. Varje tagg ska ha sin kategori,
            # inte tvärtom (tidigare lagrades kategorinamn som taggar).
            all_tags = {t for tags in taxonomy.values() for t in tags}
            for category, tags in (taxonomy.items() if isinstance(taxonomy, dict) else []):
                if not isinstance(tags, list):
                    continue
                for tag in tags:
                    cur.execute(
                        "insert into competence (tag, category) values (%s,%s) "
                        "on conflict (tag) do update set category = excluded.category, "
                        "description = null",
                        (tag, category),
                    )
                # Pseudorader (kategorinamn som inte är riktiga taggar) tas bort.
                if category not in all_tags:
                    cur.execute(
                        "delete from competence c where c.tag = %s "
                        "and not exists (select 1 from person_competence pc where pc.competence_id = c.id) "
                        "and not exists (select 1 from employment_competence ec where ec.competence_id = c.id)",
                        (category,),
                    )
            # Överflödiga taggar som inte längre finns i YAML:en tas bort.
            cur.execute(
                "delete from competence c "
                "where not (c.tag = any(%s)) "
                "and not exists (select 1 from person_competence pc where pc.competence_id = c.id) "
                "and not exists (select 1 from employment_competence ec where ec.competence_id = c.id)",
                (sorted(all_tags),),
            )

            # --- personer ---------------------------------------------------
            new = upd = skipped = 0
            dup_candidates: list[tuple[str, str, str]] = []

            # Poster som slagits ihop med en annan (fn_merge_people) hoppas
            # över - annars skulle importen skapa tillbaka dubbletten.
            cur.execute("select dropped_external_id, keep_external_id from person_merge")
            merged = {row["dropped_external_id"]: row["keep_external_id"] for row in cur.fetchall()}

            for p in people:
                name = p.get("name", "").strip()
                if not name:
                    continue
                if p.get("id") and p["id"] in merged:
                    skipped += 1
                    print(f"  info: '{p['id']}' är sammanslagen med '{merged[p['id']]}' - hoppas över")
                    continue
                nn = norm(name)
                org_name = p.get("org")
                org_nn = norm(org_name)
                org_id = _resolve_org(cur, org_name, org_ids, p.get("org_type")) if org_name else None
                if org_id and p.get("location"):
                    cur.execute(
                        "update organization set city = coalesce(city, %s) where id = %s",
                        (p.get("location"), org_id),
                    )

                # dubblettkoll
                cur.execute(
                    "select person_id, full_name, similarity, same_org "
                    "from fn_find_duplicates(%s, %s, 0.80) limit 5",
                    (name, org_name),
                )
                dups = cur.fetchall()
                if dups:
                    best = dups[0]
                    if best["similarity"] >= 0.92 and (best["same_org"] or len(dups) == 1):
                        # samma person -> uppdatera i stället för att duplicera
                        person_id = best["person_id"]
                        upd += 1
                        exp_years, exp_basis = it_experience(p)
                        cur.execute(
                            "update person set title = coalesce(%s,title), "
                            "organization_id = coalesce(%s,organization_id), "
                            "location = coalesce(%s,location), "
                            "location_confidence = coalesce(%s,location_confidence), "
                            "data_confidence = coalesce(%s,data_confidence), "
                            "seniority = coalesce(%s,seniority), "
                            "email = coalesce(%s,email), phone = coalesce(%s,phone), "
                            "it_experience_years = coalesce(%s,it_experience_years), "
                            "it_experience_basis = coalesce(%s,it_experience_basis), "
                            "available_from = coalesce(%s,available_from), "
                            "spoken_languages = coalesce(%s::text[], spoken_languages), "
                            "updated_at = now() where id = %s",
                            (p.get("title"), org_id, p.get("location"), p.get("location_confidence"),
                             p.get("confidence"), p.get("seniority"),
                             (p.get("contact") or {}).get("email"),
                             (p.get("contact") or {}).get("phone"),
                             exp_years, exp_basis,
                             parse_date(p.get("available_from")),
                             p.get("spoken_languages") or None, person_id),
                        )
                        _sync_current_employment(cur, person_id, org_id, p.get("title"), src_ids, p)
                        _link_sources(cur, person_id, p, src_ids)
                        _link_competences(cur, person_id, p, src_ids)
                        continue
                    dup_candidates.append((name, org_name or "", f"{best['similarity']:.2f}"))

                # ny person
                given, family = split_name(name)
                contact = p.get("contact") or {}
                exp_years, exp_basis = it_experience(p)

                cur.execute(
                    """
                    insert into person (external_id, full_name, normalized_name, given_name,
                        family_name, title, seniority, organization_id, location,
                        location_confidence, data_confidence, linkedin_slug, email, phone,
                        contact_published, lawful_basis, legal_basis_note, contact_state,
                        do_not_contact, retention_until, it_experience_years,
                        it_experience_basis, available_from, spoken_languages, notes, extra)
                    values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,false,%s,%s,%s,%s,%s,%s,%s)
                    on conflict (external_id) where external_id is not null do update
                      set title = excluded.title, location = excluded.location,
                          location_confidence = excluded.location_confidence,
                          data_confidence = excluded.data_confidence,
                          email = excluded.email, phone = excluded.phone,
                          it_experience_years = excluded.it_experience_years,
                          it_experience_basis = excluded.it_experience_basis,
                          available_from = excluded.available_from,
                          spoken_languages = excluded.spoken_languages,
                          updated_at = now()
                    returning id, (xmax = 0) as inserted
                    """,
                    (
                        p.get("id"), name, nn, given, family, p.get("title"), p.get("seniority"),
                        org_id, p.get("location"), p.get("location_confidence"),
                        p.get("confidence"),
                        next((s["url"].split("/in/")[-1] for s in p.get("sources", [])
                              if "linkedin.com/in/" in s.get("url", "")), None),
                        contact.get("email"), contact.get("phone"),
                        bool(contact.get("email") or contact.get("phone")),
                        (doc.get("legal") or {}).get("lawful_basis", "legitimate_interests"),
                        (doc.get("legal") or {}).get("art_14_note"),
                        "verified" if p.get("confidence") == "high" else "lead",
                        retention, exp_years, exp_basis,
                        parse_date(p.get("available_from")),
                        # spoken_languages är NOT NULL i schemat - tom array,
                        # inte None, annars faller inserten på NOT-null.
                        p.get("spoken_languages") or [],
                        p.get("notes"),
                        Jsonb({"linkedin_urn": next((s["url"] for s in p.get("sources", [])
                                               if "linkedin.com/in/" in s.get("url", "")), None),
                         "yaml_id": p.get("id")}),
                    ),
                )
                row = cur.fetchone()
                person_id = row["id"]
                if row["inserted"]:
                    new += 1
                    primary_src = src_ids.get(p["sources"][0]["url"]) if p.get("sources") else None
                    cur.execute(
                        "insert into person_employment (person_id, organization_id, title, is_current, "
                        "source_id, employment_type, confidence) "
                        "values (%s,%s,%s,true,%s,'employment',%s)",
                        (person_id, org_id, p.get("title"), primary_src,
                         p.get("confidence") or "low"),
                    )
                else:
                    upd += 1

                _link_sources(cur, person_id, p, src_ids)
                _link_competences(cur, person_id, p, src_ids)

            # --- anställningshistorik (CV-format) --------------------------
            jobs = _import_employment(cur, args.employment_file, src_ids, org_ids)
            documented = _apply_documented_experience(cur)

            # --- anställningshistorik: fyll på saknad källa -----------------
            # Kör även på befintliga rader så att staleness-kontrollen fungerar.
            cur.execute(
                """
                update person_employment e
                set source_id = sub.source_id
                from (
                    select p.id as person_id, ps.source_id
                    from person p
                    join lateral (
                        select ps2.source_id
                        from person_source ps2
                        join source s2 on s2.id = ps2.source_id
                        where ps2.person_id = p.id
                        order by s2.accessed_at desc
                        limit 1
                    ) ps on true
                ) sub
                where e.person_id = sub.person_id
                  and e.is_current
                  and e.source_id is null
                """
            )

            # --- bevakningslista -------------------------------------------
            wl_id = None
            if not args.no_watchlist:
                cur.execute(
                    "insert into watchlist (name, description, owner_email) "
                    "values (%s,%s,%s) on conflict (name) do update set owner_email = excluded.owner_email "
                    "returning id",
                    (args.watchlist,
                     "Automatiskt importerad från frölistan. Dubblettkör mot denna innan kontakt.",
                     args.watchlist_owner or None),
                )
                wl_id = cur.fetchone()["id"]
                cur.execute(
                    """
                    insert into watchlist_entry (watchlist_id, person_id, owner_email, state)
                    select %s, id, %s,
                           case when data_confidence = 'high' then 'verified'::contact_state
                                else 'lead'::contact_state end
                    from person
                    on conflict (watchlist_id, person_id) do update set state = excluded.state
                    """,
                    (wl_id, args.watchlist_owner or None),
                )

            cur.execute(
                "update import_run set finished_at = now(), persons_in = %s, persons_new = %s, persons_upd = %s "
                "where id = %s",
                (len(people), new, upd, run["id"]),
            )

            cur.execute("select count(*) as c from person")
            total = cur.fetchone()["c"]
            cur.execute("select count(*) as c from organization")
            orgs = cur.fetchone()["c"]
            cur.execute("select count(*) as c from person_source")
            psrc = cur.fetchone()["c"]
            cur.execute("select count(*) as c from person_competence")
            pcomp = cur.fetchone()["c"]
            cur.execute(
                "select count(*) as c from v_people_full where documented_months > 0"
            )
            documented_people = cur.fetchone()["c"]

        conn.commit()

    print(f"klart: {new} nya, {upd} uppdaterade, {skipped} hoppade över")
    print(f"databasen: {total} personer, {orgs} organisationer, "
          f"{psrc} person-källa-kopplingar, {pcomp} kompetenskopplingar")
    print(f"anställningshistorik: {jobs} kuraterade rader, {documented_people} personer med dokumenterad anställningstid")
    if dup_candidates:
        print(f"\n{len(dup_candidates)} möjliga dubbletter att granska manuellt:")
        for n, o, s in dup_candidates[:20]:
            print(f"  {n} @ {o or '-'}  (likhet {s})")
    return 0


def _sync_current_employment(cur, person_id, org_id, title, src_ids, p) -> None:
    """Håller den aktuella anställningsraden i synk med personens uppgifter.

    Rader som importerats ur employment-history.yaml har ett 'ref' och lämnas
    ifred. Rader utan ref är legacy-rader från första importen - de uppdateras
    så att de inte blir inkonsekventa mot personens titel/organisation.
    """
    cur.execute(
        "select id from person_employment where person_id = %s and ref is null and is_current limit 1",
        (person_id,),
    )
    row = cur.fetchone()
    if not row:
        return
    primary_src = None
    if p.get("sources"):
        primary_src = _resolve_source(cur, p["sources"][0]["url"], src_ids,
                                       p["sources"][0].get("type", "other"), p.get("name"))
    cur.execute(
        "update person_employment set organization_id = coalesce(%s, organization_id), "
        "title = coalesce(%s, title), source_id = coalesce(%s, source_id) where id = %s",
        (org_id, title, primary_src, row["id"]),
    )


def _link_sources(cur, person_id: int, p: dict, src_ids: dict) -> None:
    for s in p.get("sources", []):
        url = s.get("url")
        if not url:
            continue
        if url not in src_ids:
            cur.execute(
                "insert into source (url, title, kind) values (%s,%s,%s) "
                "on conflict (url) do update set title = coalesce(excluded.title, source.title) "
                "returning id",
                (url, p.get("name"), SOURCE_KIND.get(s.get("type", "other"), "other")),
            )
            src_ids[url] = cur.fetchone()["id"]
        cur.execute(
            "insert into person_source (person_id, source_id) values (%s,%s) "
            "on conflict do nothing",
            (person_id, src_ids[url]),
        )


def _link_competences(cur, person_id: int, p: dict, src_ids: dict) -> None:
    tags = p.get("competence", []) or []
    for tag in tags:
        cur.execute(
            "insert into competence (tag) values (%s) on conflict (tag) do nothing",
            (tag,),
        )
        cur.execute(
            "insert into person_competence (person_id, competence_id, source_id) "
            "select %s, c.id, %s from competence c where c.tag = %s "
            "on conflict (person_id, competence_id) do nothing",
            (person_id, src_ids.get(p["sources"][0]["url"]) if p.get("sources") else None, tag),
        )
    # YAML-filen är källan - taggar som tagits bort ska inte ligga kvar.
    if tags:
        cur.execute(
            "delete from person_competence pc using competence c "
            "where pc.competence_id = c.id and pc.person_id = %s and not (c.tag = any(%s))",
            (person_id, tags),
        )


if __name__ == "__main__":
    # Importeringen är idempotent - en omkörning efter ett tillfälligt fel
    # (nätverk, kallstart, stale plan-cache efter schemaändring) är säker.
    raise SystemExit(retry(main))
