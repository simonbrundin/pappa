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
  app/pages/mail/   Mailagentens sidor (inkorg, regler, Kameo-lån)
  server/api/mail/  Proxy till mailagentens HTTP-API
src/go/         Mailagenten - AI-tjänsten som läser och sorterar mail
  main.go          HTTP-server (API v1 + MCP)
  imap/ oauth/ ai/ actions/ rules/   IMAP/SMTP, Microsoft-inloggning, modell, åtgärder
  config/config.yaml  Konton och AI-inställningar
  rules.md          Regler som AI:n följer
src/neon/       Neon-integration (policy, env-variabler, anslutning)
  neon.ts         Policy: vilka tjänster branchen har
  env.sh / env.py / pappa_db.py  Env + anslutning
specs/          Feature-specifikationer (t.ex. mailagenten)
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

### Mailagenten lokalt

```bash
docker build -t mailagent:latest src/go
docker run -d --name mailagent -p 8401:8401 \
  --env-file environments/dev/mail.env mailagent:latest
cd src/nuxt && npm run dev    # proxar /api/mail -> localhost:8401
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

Knappar **"⬆ Uppdrag"** (eller `/uppdrag`) leder till vyn där en kravprofil
formuleras och kandidaterna rankas mot den.

`fn_match_candidates()` rankar kandidaterna mot en kravprofil i
`job_profile`. Poängen är alltid delpoäng + förklaring, så att beslutet kan
motiveras:

```sql
select score, full_name, organization, array_to_string(explanation, E'\n  - ')
from fn_match_candidates('PROFIL-ID'::uuid)
where eligible;
```

Profilen sätts upp i UI:t: must-have, "minst N av M", nice-to-have, ort,
pendelorter, senioritet, minsta antal år och vikter per del. Vikterna ligger i
profilens `weights` (jsonb) och justeras per uppdrag utan kodändring.

Att spara en kravprofil kräver admin-token (`NUXT_ADMIN_TOKEN`) - samma token
som dubblettsammanslagningen. Läsning och rankning kräver ingen token.

## Admin-token

Skrivning mot masterdatabasen (dubblettsammanslagning, kravprofiler) kräver
en token. Den skapas och sprids med ett skript - aldrig för hand och aldrig
i repot:

```bash
npm run admin:token init      # skapa token i src/nuxt/.env (gitignorad, 600)
npm run admin:token show      # visa token - mata in i gränssnittet
npm run admin:token apply <namespace>   # skapa Secret pappa-admin i klustret
npm run admin:token status    # var token finns
```

Servern letar upp token i `NUXT_ADMIN_TOKEN` (processmiljön eller
Kubernetes Secret `pappa-admin`) och faller tillbaka på `src/nuxt/.env`.
Utan token är skrivning avstängd (503) - läsning och rankning fungerar
ändå. Se `src/nuxt/README.md` för detaljer.

`src/nuxt/.dockerignore` hindrar att env-filen kopieras in i Docker-imagen.
Token får aldrig finnas i en image.

```bash
curl localhost:3000/api/profiles
curl "localhost:3000/api/matches?profile=PROFIL-ID"
```

Se `db/README.md` (avsnitt 10) och `db/test_match.sql`.

## Mailagenten

Utöver masterdatabasen kör repot **mailagenten** (`src/go`) - en AI-tjänst
som läser mejl, matchar dem mot regler och föreslår åtgärder (svara, flytta,
arkivera). Klienten är en Go-tjänst med två ytor:

- HTTP-API `/api/v1` - används av webbappen
- MCP-endpoint `/mcp` - används av agenter (Claude m.fl.)

### Sidor i webbappen

| Sida | Innehåll |
|---|---|
| `/mail` | Inkorgen - läsa mejl, analysera med AI, godkänna/avvisa åtgärder |
| `/mail/rules` | Regeleditorn |
| `/mail/kameo-utbetalningar` | Låneuppgifter från Kameo (kort- och långsiktig) |

### Så pratar webbappen med klienten

Webbappen går **aldrig** direkt mot mailagenten. Anropen går via Nuxt:s egen
serverproxy `server/api/mail/[...path].ts`, som vidarebefordrar till
`NUXT_MAIL_API_BASE` (`http://mailagent:8401/api/v1` i klustret). Det ger
tre fördelar: webbläsaren slipper CORS, SSR i klustret når klienten via
DNS-namnet `mailagent`, och klientens adress behöver inte finnas i klienten.

### Hemligheter

`MAIL_PASSWORD_MICHAEL` (IMAP), `OPENAI_API_KEY` (AI) och Kameo-uppgifterna
(`KAMEO_EMAIL`, `KAMEO_PASSWORD`, `KAMEO_TOTP_SECRET`) ligger i
`environments/dev/mail.env` (gitignorad) och sprids till klustret som
Secret `pappa-mail-secrets`:

```bash
npm run mail:secrets apply <namespace>   # skapa/uppdatera Secretet
npm run mail:secrets status               # var hemligheterna finns
```

Utan Secretet startar tjänsterna ändå - men klienten kan inte logga in, och
Kameo-sidan svarar 502.

### I klustret

`environments/base/mailagent-deployment.yaml` deployar klienten (Tilt bygger
imagen ur `src/go/Dockerfile`). OAuth-token cachas i en emptyDir, så en
inloggning (Microsoft device-code) måste göras om när poden skapas om.
Inloggningen sker från UI:t: `/mail` → välj kontot → "Logga in med Microsoft"
→ mata in koden i webbläsaren.

### Känt begränsning

Regelendpointet är en stub: `PUT /api/v1/rules` kvitterar men sparar inte,
och `GET` returnerar en fast text. Reglerna som AI:n faktiskt använder läses
ur `src/go/rules.md` i imagen. Detta är kvar från mailmaster-repot - se
`specs/ai-mail-processor.md`.
