# pappa

Masterdatabas för IT-rekrytering i Sundsvall. Personer, organisationer,
kompetenser och källor - med GDPR inbyggt i schemat, inte i ett papper.

Körs på [Neon](https://neon.com) (Lakebase Postgres) i EU-regionen.

## Struktur

```
data/           Frölistan (YAML) + SCB-statistik
  sundsvall-it-people.yaml    140 namngivna personer med källor
  employment-history.yaml      Anställningshistorik i CV-format (kuraterad)
db/             Applikationens datalager
  schema.sql      Tabeller, vyer, GDPR-funktioner
  import_from_yaml.py  Importerar frölistan + anställningshistorik (idempotent)
  extract_employment_candidates.py  Kandidater ur notes (halvautomatiskt)
  regenerate_people_yaml.py  Skriver om people:-sektionen i YAML ur databasen
  migrate.sh / backup.sh / restore.sh  Drift
  queries.sql     Driftfrågor
src/nuxt/       Webappen (Nuxt) - läser personerna via /api/people
src/neon/       Neon-integration (policy, env-variabler, anslutning)
  neon.ts         Policy: vilka tjänster branchen har
  env.sh / env.py / pappa_db.py  Env + anslutning
environments/   Kubernetes-manifest (Kustomize + Tilt)
  dev/             Dev-miljön - kör mot Neon, ingen databas i klustret
  prod/            Produktionsmanifest
```

Webappen och datalagret delar samma Neon-databas: `src/neon/.env.local` är
den enda källan för anslutningssträngen, och båda läser den.

## Snabbstart

```bash
npm run build        # validera Neon-policyn + kompilera Python-koden
npm run db:migrate   # skapa schemat
npm run db:import    # ladda frölistan + anställningshistorik
npm run neon:deploy  # applicera Neon-policyn

cd src/nuxt && npm run build && npm run dev   # webappen
```

## Dev i klustret (Tilt)

Dev kör mot samma Neon-databas - det finns ingen Postgres i klustret:

```bash
environments/dev/neon/sync-env.sh   # genererar neon.env ur src/neon/.env.local
cd environments/dev && tilt up
```

Mer i `db/README.md`, `src/neon/README.md` och `environments/dev/neon/README.md`.

## Anställningshistorik

Utöver den aktuella tjänsten finns en **kuraterad anställningshistorik** per
person - var, vad, hur länge - i `data/employment-history.yaml`. Den gör det
möjligt att bedöma erfarenhet på riktigt i stället för att gissa ur rollnivå,
och den visas som ett CV i personkortet.

```bash
python db/extract_employment_candidates.py   # kandidater ur notes att granska
npm run db:import                            # idempotent import av båda filerna
```

## Dubbletter

Knappar "⇄ Dubbletter" visar par som bör granskas av en människa. En kandidat
kräver att **både förnamn och efternamn** stämmer (eller att e-post/telefon är
identiska) - ett gemensamt förnamn räcker inte, så "Mikael Gidlund" och
"Mikael Nordlund" inte längre föreslås som dubbletter. Varje par kan antingen
**slås ihop** eller markeras som **"behåll båda"**, så att det inte visas
igen.

Sammanslagning kräver admin-token (`NUXT_ADMIN_TOKEN`) och registreras i
`person_merge`, så att nästa YAML-import inte skapar tillbaka den raderade
posten. Se `db/README.md` för matchningsregeln i detalj och
`db/test_merge.sql` för testerna.

## Uppdragsmatchning

`fn_match_candidates()` rankar kandidaterna mot en kravprofil i
`job_profile`. Poängen är alltid delpoäng + förklaring, så att beslutet kan
motiveras:

```sql
select score, full_name, organization, array_to_string(explanation, E'\n  - ')
from fn_match_candidates('PROFIL-ID'::uuid)
where eligible;
```

Vikterna ligger i profilens `weights` (jsonb) och justeras per uppdrag utan
kodändring. Se `db/README.md` (avsnitt 10) och `db/test_match.sql`.
