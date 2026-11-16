---
status: implemented
priority: high
tags: [rekrytering, kanban, pipeline, teams]
created: 2026-02-11
completed: 2026-02-11
---

# Kandidatpipeline (kanban)

## Problem

Rekryteringsflödet finns bara som en lista i pappersform:

1. Hitta kandidat (sökvägar + "solla")
2. Finns kandidaten i Teams under Rekrytering? (1/4 försvinner)
3. Tumme upp från anställd? (1/5 försvinner)
4. Tumme upp från grundarna? (1/7 försvinner)
5. Kontakta kandidaten (9/10 försvinner)
6. Lunch (4/5 försvinner)
7. Kritat papper

Listan är otydlig på tre sätt:

- **Steg 1 är inte ett stadium.** Sökvägarna är *var kandidaten kom ifrån* och
  "solla" (yrke, stad, teknikkompetens) är *filter* - de är redan implementerade
  på `/kandidater`. Sourcingen fyller listan, den är inte en kolumn.
- **Steg 2–4 är beslut, inte tillstånd.** De är ja/nej-frågor som snabbt avgörs.
- **Ratterna är inte entydiga** - "försvinner" kan betyda före eller efter steget.

Dessutom finns ingen plats där pipeline-statusen lagras. `person.contact_state`
(`lead`/`verified`/`contacted`/...) och `watchlist_entry.state` rymmer inte
granskning, lunch eller kritat papper.

## Beslut

| Fråga | Beslut |
|---|---|
| Board per uppdrag eller per person? | **Per person.** Ett board, inget `job_profile`-koppling. |
| Flera roller per person? | Ja - en pipeline-rad per (person, roll), boarden visar en rad per person. |
| Var ligger Teams-korten? | **Microsoft Planner-board** (B1=c). Kort = Planner-uppgifter. |
| Graph-behörighet i tenanten? | **Okänt** (B2=c) - därför **CSV-import först**, Graph-koppling senare. |
| Hur identifieras rörare? | **Namn-väljare** (C1=a) - en `pipeline_voter`-lista i DB. |
| Prognos av antal? | Nej - bara verkliga antal per steg. |

## Lösning

### Steg (boardens kolumner)

| Kolumn | Enteringskriterium | Utträffskriterium | Beslutsfattare |
|---|---|---|---|
| `sourced` 🔍 Sökt | Kandidat har lagts till från `/kandidater` | — | Den som söker |
| `teams_check` 🪪 Teams-koll | Har taggat "finns i Planner-listan?" | Svar: nej (annars bortfall) | Den som söker |
| `review` 👍 Granskning | Svarat "nej" på Teams-koll | Anställd **och** grundare har röstat ja | Anställd + grundare |
| `contacted` ✉️ Kontaktad | Granskning godkänd | Svarat (vill vidare / tackar nej) | Den som driver |
| `lunch` 🍽️ Lunch | Kontaktat och vill vidare | Lunchad | Den som driver |
| `paper` 🥂 Kritat papper | Lunchad | Pappersgranskning klar | Grundarna |
| `hired` ✅ Anställd | Kritat papper godkänt | — | Grundarna |
| `dropped` 🚫 Bortfall | Alla steg | Bortfall med orsak | Den som driver |

Bortfall ligger i en egen vy (filter "Visa bortfallna"), inte i en kolumn -
annars fylls boarden med döda kort.

### Sourcing (steg 1) - attribut, inte kolumn

- `pipeline_source`: `linkedin`, `arbetsforrmedlingen`, `boolag`, `myndighet`,
  `it_bolag_sundsvall`, `soulmate_kontakt`, `annat`
- "Solla" = befintliga filter på `/kandidater` (yrke = titel/senioritet,
  stad = `location`, kompetens = `competences`)

### Datamodell

```sql
pipeline_stage      ('sourced','teams_check','review','contacted','lunch','paper','hired','dropped')
pipeline_voter_role ('employee','founder')
pipeline_source     (sökvägarna ovan)

pipeline_voter (id, name unique, role, active)
candidate_pipeline (id, person_id, role_label, stage, source, source_note,
                   owner_id -> pipeline_voter, note, drop_reason,
                   teams_ref, entered_stage_at, created_at, updated_at,
                   unique (person_id, role_label))
pipeline_event (id, pipeline_id, from_stage, to_stage, actor, note, at)
pipeline_vote (id, pipeline_id, voter_id, voter_role, approved, note, at,
               unique (pipeline_id, voter_role))
planner_card (id, external_id unique, title, bucket, description,
              linkedin_slug, raw jsonb, person_id, match_score, match_kind,
              imported_at)
```

En pipeline-rad per (person, roll). Boarden grupperar per person; kolumnen är
personens *fördelade* stage (den längst fram).

### API

| Endpoint | Skrivning | Beskrivning |
|---|---|---|
| `GET /api/pipeline` | nej | Boarden: kort, röster, räknare, voter-lista |
| `POST /api/pipeline` | admin-token | `op=create\|move\|update\|drop` |
| `POST /api/pipeline/vote` | admin-token | Röst (anställd/grundare), auto-hopp när båda röstat ja |
| `GET/POST /api/pipeline/voters` | ja / admin-token | Lägg till rörare |
| `GET /api/planner` | nej | Importerade Planner-kort + matchningsstatus |
| `POST /api/planner/import` | admin-token | CSV-import + matchning |
| `POST /api/planner/link` | admin-token | Länka omatchat kort till en person |

### Matchning mot personregistret

`fn_match_person(p_name, p_org)`:
1. Exakt normaliserat namn -> score 1.0, `kind='exact'`.
2. Annars `fn_name_match`: båda namndelar >= 0.75 -> score = medel, `kind='name'`.
3. Organisationen måste stämma om den anges (annars `kind='name_only'`, lägre poäng).
4. `score >= 0.75` -> automatchning, annars visas kortet som omatchat.

Kort som matchar ingen hamnar i en "omatchade"-lista där en människa kan länka
dem. **Inga tysta felmatchningar** - det är personuppgifter.

### GDPR

- Pipeline-data är personuppgifter: `retention_until` gäller som för personen.
- "Tackar nej" -> `person.do_not_contact = true` och bortfall med orsak.
- Kontaktuppgifter visas i boarden först efter "visa kontakt"-klick.
- Avslutad rekrytering -> `person.contact_state` uppdateras.

## Implementation

1. `db/schema.sql`: typer, tabeller, `fn_match_person`, vy `v_pipeline_board`.
2. `src/nuxt/shared/types/pipeline.ts`: typer för API-svar.
3. Server: `server/api/pipeline.get.ts`, `pipeline.post.ts`,
   `pipeline/vote.post.ts`, `pipeline/voters.get.ts`, `pipeline/voters.post.ts`,
   `planner.get.ts`, `planner/import.post.ts`, `planner/link.post.ts`.
4. UI: `app/pages/pipeline.vue` (board med drag-and-drop), `app/components/PipelineCard.vue`,
   nav-post i `app/layouts/default.vue`.
5. `/kandidater`: pipeline-chip per person + "Lägg i pipeline".
6. Tester: `db/test_pipeline.sql` (matchning) + `src/nuxt/server/tests/pipeline.test.ts`.

## Status

- [x] Define
- [x] Plan
- [x] Execute
- [x] Verify

Verifierat: `db/test_pipeline.sql` (matchning, roller, röster),
`bun test server/tests` (CSV-parser), `npm run typecheck`, samt manuella
API-anrop mot lokal Postgres (create -> move -> röster -> bortfall,
CSV-import med 2 av 3 kort matchade).

## Senare (inte nu)

- Graph/Planner-automatik (`Tasks.Read.All` + admin consent i tenanten).
- Entra ID-inloggning så att röstar är automatiskt kända.
- Prognos av utfall per steg.
