#!/usr/bin/env python3
"""Regenerera `people:`-sektionen i data/sundsvall-it-people.yaml ur databasen.

Varför: YAML-filen är frölistan, men masterdatabasen (Neon/Postgres) är det
som appen faktiskt läser. Om YAML-filen skadas eller redigeras fel kan
personsektionen återskapas härifrån - alla fält (titel, organisation, källor,
kompetenser, kontakt, noter, erfarenhetsgrund) finns i databasen.

Övriga sektioner (meta, legal, employers_to_work, sources, competence_taxonomy,
next_steps, notes) lämnas orörda - de är redaktionellt och finns bara i YAML.

Kör:
    unset DATABASE_URL && source src/neon/env.sh
    uv run --with "psycopg[binary]" --with pyyaml python db/regenerate_people_yaml.py

Varning: skriver över people:-sektionen. Kontrollera med git diff.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg
import yaml
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "neon"))
from env import load_env  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "data" / "sundsvall-it-people.yaml"

ORG_TYPE_BY_KIND = {
    "consultancy": "privat",
    "public_sector": "offentlig",
    "academia": "akademi",
    "industry": "industri",
    "vendor": "leverantör",
    "other": "annan",
}
SOURCE_TYPE_BY_KIND = {
    "company_site": "org_website",
    "profile": "linkedin_public",
    "conference": "conference",
    "community": "community",
    "public_record": "public_record",
    "register": "register",
    "press": "press",
    "manual": "manual",
    "other": "other",
}

PEOPLE_SQL = """
select p.external_id,
       p.full_name,
       p.title,
       p.seniority,
       p.location,
       p.location_confidence,
       p.data_confidence,
       p.email,
       p.phone,
       p.it_experience_years,
       p.it_experience_basis,
       p.available_from,
       p.spoken_languages,
       p.notes,
       o.name  as org,
       o.kind  as org_kind,
       (select jsonb_agg(c.tag order by c.tag)
          from person_competence pc
          join competence c on c.id = pc.competence_id
         where pc.person_id = p.id)                        as competence,
       (select jsonb_agg(jsonb_build_object('url', s.url, 'kind', s.kind) order by s.url)
          from person_source ps
          join source s on s.id = ps.source_id
         where ps.person_id = p.id)                        as sources
  from person p
  left join organization o on o.id = p.organization_id
 order by p.full_name
"""


def q(value) -> str:
    """Scalar i YAML: citera bara om det behövs."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    needs = (
        text[0] in "-?:,[]{}#&*!|>'\"%@`"
        or text[-1] == " "
        or ": " in text
        or " #" in text
        # I flow-sammanhang (t.ex. { url: ... }) är ",", "[", "]", "{" och "}"
        # indikatorer - utan citat bryts värdet sönder vid parsning.
        or any(ch in text for ch in ",[]{}")
        or any(ch in text for ch in "#&*!|>'\"%@`")
        or text.lower() in {"null", "true", "false", "yes", "no", "on", "off", "~"}
    )
    if needs:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def flow(items) -> str:
    return "[" + ", ".join(q(i) for i in items) + "]"


def org_type(org: str | None, kind: str | None) -> str:
    if not org or org == "(ej angiven)":
        return "unknown"
    if kind:
        return ORG_TYPE_BY_KIND.get(kind, "annan")
    if "User Group" in org or "Dragon" in org:
        return "community"
    return "privat"


def source_type(url: str, kind: str) -> str:
    if kind == "other" and "goodtechconference.se/program" in url:
        return "conference_program"
    return SOURCE_TYPE_BY_KIND.get(kind, "other")


def person_block(p: dict) -> str:
    lines = [f"  - id: {p['external_id']}"]
    lines.append(f"    name: {q(p['full_name'])}")
    if p.get("title"):
        lines.append(f"    title: {q(p['title'])}")
    lines.append(f"    org: {q(p['org'])}")
    lines.append(f"    org_type: {org_type(p.get('org'), p.get('org_kind'))}")
    if p.get("location"):
        lines.append(f"    location: {q(p['location'])}")
        lines.append(f"    location_confidence: {p.get('location_confidence') or 'low'}")
    if p.get("seniority"):
        lines.append(f"    seniority: {p['seniority']}")
    # it_experience_years skrivs bara ut när värdet är explicit källbelagt.
    # 'seniority'/'notes'/'documented' härleds av importen - att skriva ut
    # dem här skulle låsa fast ett gissat värde som källa.
    if p.get("it_experience_basis") == "explicit" and p.get("it_experience_years") is not None:
        lines.append(f"    it_experience_years: {p['it_experience_years']}")
    if p.get("available_from"):
        lines.append(f"    available_from: {q(p['available_from'])}")
    tags = p.get("competence") or []
    tags = [t["tag"] if isinstance(t, dict) else t for t in tags]
    lines.append(f"    competence: {flow(tags)}")
    contact = {}
    if p.get("email"):
        contact["email"] = p["email"]
    if p.get("phone"):
        contact["phone"] = p["phone"]
    if contact:
        lines.append("    contact: { " + ", ".join(f"{k}: {q(v)}" for k, v in contact.items()) + " }")
    else:
        lines.append("    contact: {}")
    sources = p.get("sources") or []
    if sources:
        lines.append("    sources:")
        for s in sources:
            lines.append(f"      - {{ url: {q(s['url'])}, type: {source_type(s['url'], s['kind'])} }}")
    if p.get("data_confidence"):
        lines.append(f"    confidence: {p['data_confidence']}")
    if p.get("notes"):
        lines.append(f"    notes: {q(p['notes'])}")
    return "\n".join(lines)


def split_sections(text: str) -> tuple[str, str]:
    """Delar filen i (allt före people:) och (allt efter people:-sektionen)."""
    lines = text.split("\n")
    start = next(i for i, l in enumerate(lines) if l.startswith("people:"))
    end = next(i for i, l in enumerate(lines) if i > start and l and not l.startswith(" ")
                and not l.startswith("#") and l.endswith(":"))
    return "\n".join(lines[:start]), "\n".join(lines[end:])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", default=str(DEFAULT_FILE), help="YAML-fil att regenerera")
    ap.add_argument("--database-url", default=None, help="Anslutningssträng (default: DATABASE_URL)")
    ap.add_argument("--dry-run", action="store_true", help="Skriv inte, visa bara resultatet")
    args = ap.parse_args()

    path = Path(args.file)
    text = path.read_text(encoding="utf-8")
    head, tail = split_sections(text)

    load_env()
    dsn = args.database_url or os.environ.get("DATABASE_URL")
    if not dsn:
        print("Saknar DATABASE_URL (eller --database-url)", file=sys.stderr)
        return 1
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        people = conn.execute(PEOPLE_SQL).fetchall()

    body = "\n".join(person_block(dict(p)) for p in people)
    new_text = f"{head}people:\n{body}\n\n{tail}"

    # Säkerhetsnät: den nya filen måste gå att tolka.
    parsed = yaml.safe_load(new_text)
    if not isinstance(parsed, dict) or "people" not in parsed:
        print("FEL: genererad fil gick inte att tolka", file=sys.stderr)
        return 1
    if len(parsed["people"]) != len(people):
        print("FEL: antal personer mismatchar", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"[dry-run] skulle skriva {len(people)} personer till {path}")
        return 0

    path.write_text(new_text, encoding="utf-8")
    print(f"skrev {len(people)} personer till {path}")
    print("Kontrollera med git diff och kör sedan om importen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
