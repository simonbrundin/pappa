#!/usr/bin/env python3
"""
pappa - Extrahera kandidater för anställningshistorik ur frölistans notes.

Databasen har en anställningshistorik i CV-format (person_employment), men
den kan inte fyllas på automatiskt - "18 år på Sogeti" räcker inte för att
räkna ut när tjänsten började och slutade.

Det här skriptet gör ett första pass: det letar efter arbetsgivare, titlar
och årtal i fritexten och skriver ut ett YAML-underlag till
data/employment-history.yaml att granska.

Det skriver ALDRIG till databasen. Kurateringen görs av en människa, och
bara rader med källa hamnar i databasen.

Kör:
  python db/extract_employment_candidates.py > /tmp/employment-kandidater.yaml
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent

# Arbetsgivare som nämns i fritexten - mönstren fångar "på X", "hos X", "vid X"
ORG_PATTERNS = [
    r"(?:på|hos|vid)\s+([A-ZÅÄÖ][\w&.\-]*(?:\s+[A-ZÅÄÖ][\w&.\-]*){0,3})",
]

# "Tid. Senior System Developer på Sogeti, TeliaSonera, Tieto"
TID_PATTERNS = [
    r"[Tt]id(?:igare)?\.?\s+(?:som\s+)?([A-ZÅÄÖ][^,.;]{3,60}?)\s+på\s+([^.;]{3,120})",
    r"[Tt]idigare\s+([A-ZÅÄÖ][^,.;]{3,60}?)\s+på\s+([^.;]{3,120})",
    r"(?<![Tt]id)\s([A-ZÅÄÖ][a-zåäö]{2,}(?:\s+(?:och|[A-ZÅÄÖ])[^,.;]{2,40}){0,3})\s+på\s+([^.;]{3,120})",
]

YEAR_RANGE = re.compile(r"\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b")
YEAR_SINCE = re.compile(r"\bsedan\s+((?:19|20)\d{2})\b")
YEAR_FOUNDED = re.compile(r"\b([Gg]rundade|[Gg]rundat)\b.*?\b((?:19|20)\d{2})\b")
YEARS_AT = re.compile(r"\b(\d{1,2})\s*\+?\s*år(?:\s+i\s+IT)?\s+(?:på|hos|vid)\s+([^.;]{2,80})")

STOP_WORDS = {
    "och", "som", "med", "till", "från", "för", "den", "det", "ett", "har",
    "var", "vid", "på", "hos", "samt", "även", "eller",
}


def load_known_orgs(doc: dict) -> list[str]:
    """Alla arbetsgivare som nämns någonstans - för att känna igen dem i text."""
    names: set[str] = set()
    for p in doc.get("people", []) or []:
        if p.get("org"):
            names.add(p["org"].strip())
    for e in doc.get("employers_to_work", []) or []:
        if e.get("org"):
            names.add(e["org"].strip())
    return sorted(names, key=len, reverse=True)


def match_org(text: str, known: list[str]) -> str | None:
    """Hittar det arbetsgivarnamn som nämns i texten."""
    for name in known:
        if name.lower() in text.lower():
            return name
    m = re.search(ORG_PATTERNS[0], text)
    if m:
        return m.group(1).strip().rstrip(",")
    return None


def split_org_list(raw: str) -> list[str]:
    """'Sogeti, TeliaSonera, Tieto' -> ['Sogeti', 'TeliaSonera', 'Tieto']."""
    parts = re.split(r",| och ", raw)
    out = []
    for part in parts:
        part = part.strip().strip(".")
        if not part or part.lower() in STOP_WORDS:
            continue
        if len(part) < 3:
            continue
        out.append(part)
    return out


def candidates_for(person: dict, known: list[str]) -> list[dict]:
    """Kandidatrader för en persons anställningshistorik."""
    notes = person.get("notes") or ""
    if not notes:
        return []

    out: list[dict] = []
    source_url = None
    for s in person.get("sources", []) or []:
        if s.get("url"):
            source_url = s["url"]
            break

    # 1. "Tid. X på A, B, C" - titeln hör till första organisationen
    for pattern in TID_PATTERNS:
        for m in re.finditer(pattern, notes):
            title = m.group(1).strip()
            orgs = split_org_list(m.group(2))
            if not orgs:
                continue
            for i, org in enumerate(orgs):
                out.append({
                    "ref": f"{person['id']}-{re.sub(r'[^a-z0-9]+', '-', org.lower()).strip('-')}",
                    "org": org,
                    "title": title if i == 0 else None,
                    "type": "employment",
                    "from": None,
                    "to": None,
                    "current": False,
                    "stack": [],
                    "confidence": "medium",
                    "source": source_url,
                    "note": "utläst ur notes - verifiera",
                })

    # 2. "18 år på Sogeti" - längd men inga datum
    for m in YEARS_AT.finditer(notes):
        org = match_org(m.group(2), known)
        if not org:
            continue
        out.append({
            "ref": f"{person['id']}-{re.sub(r'[^a-z0-9]+', '-', org.lower()).strip('-')}",
            "org": org,
            "title": None,
            "type": "employment",
            "from": None,
            "to": None,
            "current": False,
            "stack": [],
            "confidence": "medium",
            "source": source_url,
            "note": f"{m.group(1)} år - startdatum okänt",
        })

    # 3. "Grundade X 2009" -> anställning med startdatum
    m = YEAR_FOUNDED.search(notes)
    if m:
        out.append({
            "ref": f"{person['id']}-grundare",
            "org": match_org(notes, known) or person.get("org"),
            "title": "Grundare",
            "type": "employment",
            "from": f"{m.group(2)}-01-01",
            "to": None,
            "current": False,
            "stack": [],
            "confidence": "medium",
            "source": source_url,
            "note": "utläst ur notes - verifiera",
        })

    # 4. "2011-2017" - tydligt datumintervall för rollen
    m = YEAR_RANGE.search(notes)
    if m:
        out.append({
            "ref": f"{person['id']}-period",
            "org": person.get("org"),
            "title": None,
            "type": "employment",
            "from": f"{m.group(1)}-01-01",
            "to": f"{m.group(2)}-12-31",
            "current": False,
            "stack": [],
            "confidence": "medium",
            "source": source_url,
            "note": "utläst ur notes - verifiera",
        })

    # 5. "VD-post sedan 2024" - pågående roll med startdatum
    m = YEAR_SINCE.search(notes)
    if m:
        out.append({
            "ref": f"{person['id']}-sedan",
            "org": person.get("org"),
            "title": None,
            "type": "employment",
            "from": f"{m.group(1)}-01-01",
            "to": None,
            "current": True,
            "stack": [],
            "confidence": "medium",
            "source": source_url,
            "note": "utläst ur notes - verifiera",
        })

    # deduplicera på ref
    unique: dict[str, dict] = {}
    for row in out:
        unique.setdefault(row["ref"], row)
    return list(unique.values())


def main() -> int:
    path = REPO / "data" / "sundsvall-it-people.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    known = load_known_orgs(doc)

    people_out = []
    for p in doc.get("people", []) or []:
        rows = candidates_for(p, known)
        if not rows:
            continue
        people_out.append({"id": p["id"], "name": p.get("name"), "employment": rows})

    header = (
        "# ANSTÄLLNINGSHISTORIK - autogenererat underlag, GRANSKA före import.\n"
        "# Genererad av db/extract_employment_candidates.py\n"
        "# Varje rad ska ha källa (source) och verifierad datum. confidence: low = hypotes.\n"
    )
    print(header)
    yaml.safe_dump({"people": people_out}, sys.stdout,
                   allow_unicode=True, sort_keys=False, default_flow_style=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
