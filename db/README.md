# pappa - driftsättning av masterdatabasen

Postgres 16, ~15 MB data för 3 500 personer. Allt nedan är testat mot en
riktig Postgres 16-container.

## Innehåll

| Fil | Syfte |
|---|---|
| `schema.sql` | Tabeller, index, enumar, vyer, GDPR-funktioner |
| `import_from_yaml.py` | Importerar frölistan YAML -> DB, med fuzzy dubblettkoll |
| `regenerate_people_yaml.py` | Skriver om `people:`-sektionen i YAML ur databasen (återställning) |
| `extract_employment_candidates.py` | Halvautomatiska anställningskandidater ur `notes` |
| `migrate.sh` | Applicerar `schema.sql` mot databasen (direkt anslutning) |
| `backup.sh` | Daglig `pg_dump` + rotasjon + verifiering |
| `restore.sh` | Återställer från backup (verifierar efteråt) |
| `queries.sql` | Driftfrågor: dubblettkoll, export, gallring |
| `test_merge.sql` | Test av dubblettsammanslagning (transaktion som rullas tillbaka) |
| `test_match.sql` | Test av uppdragsmatchningen (transaktion som rullas tillbaka) |
| `docker-compose.yml` | Lokal dev-databas (+ valfritt PgAdmin) |

Neon-lagret (policy, env-variabler, anslutning) ligger i `src/neon/`.
Kubernetes-manifesten (Tilt/Kustomize, utan databas i klustret) ligger i
`environments/`.

## 1. Välj värd (gratis)

| Leverantör | Gratis | Passar när |
|---|---|---|
| **Neon** (rekommenderas) | 1 GB lagring/projekt, 100 CU-tim/mån, scale-to-zero efter 5 min, **inget kortkort** | Ren Postgres, ingen GUI behövs. Har SQL-over-HTTP (REST) som Power Automate kan anropa. |
| **Supabase** | 500 MB DB, pausar efter 1 veckas inaktivitet, Studio-GUI, Auth, REST | Du vill att kollegor ska klicka i en tabellvy, eller vill koppla in en webbapp. **Kräver RLS** (se nedan). |
| **Aiven** | 1 GB disk, 1 GB RAM, 1 CPU | Vill ha en leverantör med tydligt processoravtal (DPA) och EU-region. |
| Oracle Always Free | 2 st autonoma DB, 20 GB | Men: svårt att provisionera, ARM-instanser sällsynt tillgängliga. |

Alla kan köras mot samma `schema.sql`. Byt bara connection string.

**Datahantering (viktigt för GDPR):**
- Välj en **EU-region** (t.ex. `eu-central-1` hos Neon, `eu` hos Aiven). Personuppgifter
  ska inte ligga utanför EU om det inte finns en särskild grund.
- Leverantören är en **personuppgiftsbiträde** -> klausul om biträdesavtal behövs
  (Neon och Aiven har DPA, kontrollera att ni klickar i den).
- **Aldrig en publik endpoint.** Databasen ska kräva inloggning. På Supabase måste
  `alter table ... enable row level security` köras på ALLA tabeller, annars läser
  PostgREST datan med `anon`-nyckeln.
- Gränsa åtkomst: Neon har IP-allow-list (betald) - annars: starkt lösenord + rotation.

## 2. Skapa databasen

### Neon
```bash
npm i -g neon@latest
neon init -y --org-id <org-id> --project-id <project-id> \
           --branch production --services postgres
neon deploy
```

`neon init` kopplar projektet, skriver `neon.ts` (vilka tjänster branchen
ska ha) och hämtar env-variablerna till `.env.local` i repo-roten:

| Variabel | Endpoint | Används för |
|---|---|---|
| `DATABASE_URL` | poolad (`-pooler`, PgBouncer) | normal frågetrafik |
| `DATABASE_URL_UNPOOLED` | direkt | migrationer, `pg_dump`, restore |
| `NEON_BRANCH` | - | branchen (`production`) |

Skripten i `db/` läser `.env.local` automatiskt - du behöver inte exportera
något manuellt. Variabler som redan är satta i miljön vinner över filen.

Miljövariablerna hamnar i `src/neon/.env.local` (där `.neon` ligger). Vill du
köra Neon-kommandona direkt:

```bash
cd src/neon && neon deploy
```

Välj EU-region (`eu-central-1`) när projektet skapas - personuppgifter ska
inte ligga utanför EU.

### Supabase
Skapa projekt i dashboarden -> Project Settings -> Database -> kopiera
`postgresql://postgres.<ref>:<lösen>@aws-0-<region>.pooler.supabase.com:6543/postgres`

### Lokalt (utveckling)
```bash
docker compose -f db/docker-compose.yml up -d
export DATABASE_URL='postgresql://pappa:pappa@127.0.0.1:55432/pappa'
```

## 3. Skapa schema och importera

```bash
export DATABASE_URL='postgresql://...'      # ~/.pgpass eller .env, inte i chatten

# 1. schema
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql

# 2. import av frölistan
uv run --with "psycopg[binary]" --with pyyaml \
  python db/import_from_yaml.py --file data/sundsvall-it-people.yaml

# 3. kontroll
psql "$DATABASE_URL" -c "select * from v_coverage;"
```

Importen är **idempotent**: kör den igen uppdaterar i stället för att duplicera.
Dubbletter under tröskeln 0.92 likhet flaggas i utdata och räknas inte som
samma person - granska dem manuellt.

### Återställning av YAML:frölistan

`data/sundsvall-it-people.yaml` är frölista, men databasen är sanningen som
appen läser. Om YAML-filen skadas kan `people:`-sektionen skrivas om ur
databasen - titel, organisation, källor, kompetenser, kontakt, noter och
erfarenhetsgrund finns där:

```bash
unset DATABASE_URL && source src/neon/env.sh
uv run --with "psycopg[binary]" --with pyyaml \
  python db/regenerate_people_yaml.py --file data/sundsvall-it-people.yaml
```

Verktyget är idempotent (kör två gånger -> samma fil) och vägrar skriva om
filen om den genererade versionen inte går att tolka. Kör importen efteråt.

### Poolad vs direkt anslutning

Neon ger två endpoints för *samma* databas. Skillnaden är inte kosmetisk:

| Sak | Poolad (`DATABASE_URL`) | Direkt (`DATABASE_URL_UNPOOLED`) |
|---|---|---|
| PgBouncer | Ja, transaktionsläge | Nej |
| `SET` / `search_path` | Funkar inte | Funkar |
| `pg_dump` / `pg_restore` | **Misslyckas** | Funkar |
| Migrationer | **Misslyckas** | Funkar |
| Antal samtidiga klienter | 10 000 | max_connections |

Därför använder `db/migrate.sh`, `db/backup.sh` och `db/restore.sh` alltid den
direkta URL:en, medan importen och vanliga frågor går via den poolade.

### Driver: psycopg 3

Projektet har ingen ORM - psycopg 3 behålls som drivrutin. `db/pappa_db.py`
hanterar anslutningen:

- Mot den **poolade** endpointen sätts `prepare_threshold=None`. psycopg
  avslutar prepared statements med SQL-nivå `DEALLOCATE`, vilket PgBouncer
  inte stödjer, och en klientsession kan byta server-session mellan
  transaktioner. För en pipeline med några tusen rader kostar det inget.
- Tillfälliga fel (nätverk, kallstart efter scale-to-zero, gammal plan-cache
  efter en schemaändring) hanteras med `retry()`. Importen är idempotent, så
  en omkörning är säker.
- **TLS kontrolleras** (`sslmode=verify-full`). Neons URL har `sslmode=require`,
  som i libpq bara betyder "kryptera utan att kontrollera certifikatet".
  `src/neon/pappa_db.py` skärper det till `verify-full` och pekar ut en
  CA-fil (`/etc/ssl/certs/ca-certificates.crt` m.fl., eller
  `PAPPA_SSLROOTCERT`). Saknas ingen CA-fil används URL:ens eget `sslmode`.
  Lokala docker-compose-databasen har ingen TLS och lämnas ifred.

### Databasen i klustret

Det finns **ingen databas i klustret** - varken i dev, PR eller prod. Neon
körs utanför, och appen ansluter över publika internet. Det som ändrades
2026-11-02:

| Tidigare | Nu |
|---|---|
| CNPG-`Cluster` i dev (`environments/dev/db`) | Neon, Secret `pappa-neon-db` |
| Atlas-operator + schema-CRD i klustret | `npm run db:migrate` utanifrån |
| `go-api` som lyste `NUXT_PUBLIC_API_BASE` | bort; Nuxt läser Postgres direkt |

Konsekvenser för drift:

- **Schemat appliceras utanifrån klustret** - `npm run db:migrate` mot den
  direkta endpointen. Ingen operator i klustret rörar schemat.
- **Secretten skapas per miljö**: dev/PR ur `environments/*/neon/*.env`
  (gitignoras, genereras av `environments/neon-env.sh`), prod externt via
  kubectl/Flux.
- **TLS utgår från Neons certifikat**, så podden behöver bara internetutgång
  - ingen CNPG, ingen Volume, ingen StatefulSet.

### Med npm

```bash
npm run build        # validerar neon.ts + kompilerar Python-koden
npm run db:migrate   # applicerar schema.sql
npm run db:import    # importerar frölistan
npm run db:backup    # pg_dump + verifiering

npm run neon:plan    # Neon: visa plan
npm run neon:deploy  # Neon: applicera policy + hämta env
npm run neon:env     # Neon: hämta env-variabler
```

## 4. Säkerhetskopiering

Gratisplan har ingen automatisk backup (Neon har 6 h historik, Supabase ingen).
Kör `db/backup.sh` dagligen via cron:

```cron
0 3 * * *  /home/simon/repos/pappa/db/backup.sh
```

Skriptet läser `.env.local` själv, så cron behöver inga hemligheter. Sätt
`BACKUP_DIR=/mnt/nas` om dumpen ska ligga någon annanstans.

Dumpen innehåller personuppgifter - lagra den krypterat och inte i repot.
Återställning: `./db/restore.sh db/backups/pappa-YYYYMMDD-HHMMSS.sql.gz`
(Backupen tas som **plain SQL + gzip**, inte custom-format: custom-formatets
versionsheader skrivs av klientens pg_dump och kan inte läsas av en leverantör
med äldre pg_restore. Plain SQL går att återställa överallt.)

## 5. GDPR i drift

- `retention_until` sätts automatiskt vid import (6 månader).
- Gallring: `select fn_purge_expired_personal_data();` - schemalägg via `pg_cron`
  (Neon: `create extension pg_cron;`) eller via cron + `psql`.
- Logga raderingar i `audit_log` (funktionen gör detta).
- `do_not_contact` + `contact_event` = av-saknad-av-kontaktlista.
- `dsr_request` = insyns- och raderingsbegäran.

## 6. Nästa steg

- **Teams-leverans:** Neon har SQL-over-HTTP. Power Automate kan POSTa till
  `https://<endpoint>/sql/v1` med `neon_api_key` och få JSON tillbaka - då behöver
  ingen klient installeras.
- **Formulär mot kandidater:** egen liten tjänst mot databasen, eller Supabase
  Edge Functions.
- **Expanderande populationen:** de 140 namngivna är ~4 % av de 3 469. Resten
  måste komma från manuellt källdata, bemanningsföretag, allmänna handlingar eller
  LinkedIn-export - inte från webbskraping.

## 7. Erfarenhet (år i IT)

Det finns ingen direktuppgift om hur länge någon arbetat med IT, så värdet
härleds och **grunden sparas** i `person.it_experience_basis`:

| Grund | Källa | Antal |
| --- | --- | --- |
| `explicit` | `it_experience_years` i YAML (källbelagt) | 10 |
| `notes` | ur fritext ("34 års erfarenhet") | 0 just nu |
| `seniority` | undre gräns från rollnivå (cxo/chef 10, lead 6, senior 5, mid 3, junior 0) | 75 |
| – | okänt (`null`) | 3 |

Regler:

- **Okänt räknas aldrig som "3+ år".** Personen kan ju ha 20 års erfarenhet,
  men vi har ingen uppgift - och ett filter får inte anta.
- Rollnivå-värdet är en **undre gräns**, inte ett facit. Det är ett filter,
  inte en uppgift om personen.
- Vill man ha verkliga data: fyll `it_experience_years` i YAML (med källa i
  `sources`) - då går värdet från `seniority` till `explicit`.

Driftfrågor finns i `queries.sql` (punkt 15-16).

Anställningshistoriken har egna driftfrågor i `queries.sql` (punkt 17-23):
CV per person, dokumenterad anställningstid, rader utan källa, dubbla
aktuella rader, överlappande perioder och teknikmappning per tjänst.

## 8. Dubbletter och sammanslagning

Databasen hittar dubblettkandidater med `fn_duplicate_candidates(min_similarity, include_weak)`.
Funktionen ger **förslag**, aldrig sanning - tre Söderberg på samma
konsultbolag är släktingar.

### Matchningsregeln

Namnet delas upp i förnamn och efternamn (`fn_name_parts`), och varje del
jämförs separat (`fn_part_match`, `fn_name_match`):

| Utfall | Poäng | Betydelse |
| --- | --- | --- |
| `exact` | 1.00 | Identiskt |
| `prefix` | 0.90 | Den ena delen är prefix av den andra ("lind"/"lindqvist"). Kräver minst 4 tecken i den kortare delen, så "per" inte matchar "petra" |
| `near` | 0.75 | 1-3 tecken fel ("anders"/"andreas", "jonatan"/"jonathan"). Kräver samma första bokstav, så "gidlund" inte matchar "nordlund" |
| `none` | 0.00 | matchar inte |

En kandidat är **stark** (`weak = false`) om något av följande gäller:

- samma e-post eller samma telefon,
- identiskt namn,
- **både** förnamn och efternamn stämmer (båda delar >= 0.75).

En kandidat är **svag** (`weak = true`) om bara en av delarna stämmer - ett
gemensamt förnamn eller ett gemensamt efternamn. Svagare par föreslås men
kan inte slås ihop i gränssnittet: "Mikael Gidlund" och "Mikael Nordlund"
har ett gemensamt förnamn, "Gert" och "Robert Söderberg" ett gemensamt
efternamn, och i båda fallen är det två olika personer.

En tidigare version jämförde hela namnet med trigramlikhet
(`similarity(...) >= 0.45`). Den gav 10 falska kandidater - "Mikael Gidlund"
och "Mikael Nordlund" fick 0.31 trigramlikhet, men ordvis jämförelse
(`word_similarity`) gav 0.50 och klassificerade dem som samma person.
Därför jämförs nu varje namndel separat.

Par som markerats som **"behåll båda"** registreras i `duplicate_dismissal`
och utesluts sedan ur listan, så att samma par inte behöver granskas igen.

### Sammanslagning

Sammanslagning sker via `fn_merge_people(p_keep, p_drop, p_actor)`:

- alla kopplingar (källor, kompetenser, anställningar, bevakningslista,
  kontaktlogg) flyttas till posten som behålls,
- tomma fält fylls från den raderade posten - befintliga värden skrivs aldrig
  över,
- högst **en** aktuell anställningsrad per person (den kuraterade raden vinner),
- den raderade postens `external_id` registreras i `person_merge`.

`person_merge` är det som gör sammanslagningen beständig: frölistan kan ju
fortfarande innehålla båda posterna, så utan registreringen skulle nästa
import skapa tillbaka dubbletten. Importer hoppar därför över `external_id`
som finns i `person_merge` och skriver ut en info-rad om det.

Testet körs i en transaktion som rullas tillbaka:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_merge.sql
```

Testet täcker både sammanslagningen och matchningsregeln: negativa fall
(ett gemensamt ord ska INNE räcka), positiva fall (identiskt namn, samma
e-post, samma telefon, prefix) och att "behåll båda" utesluter paret.

## 9. Anställningshistorik (CV-format)

`person_employment` håller anställningshistorik: **var, vad, hur länge** - en
rad per tjänst, precis som på ett CV.

| Fält | Betydelse |
| --- | --- |
| `organization_id` | Var (länk till `organization`) |
| `title` | Vad (roll) |
| `valid_from` / `valid_to` | Hur länge. Månadprecision. |
| `is_current` | Pågående tjänst |
| `employment_type` | `employment`, `freelance`, `consultant`, `project`, `education` |
| `seniority` | Rollnivå *under den perioden* (personens `seniority` är den aktuella) |
| `stack` | Teknik under perioden (fritext-taggar) |
| `confidence` | `high` (belagd av källa), `medium` (utläst ur fritext), `low` (hypotes) |
| `source_id` | Källa som belägger just den raden |
| `ref` | Idempotent nyckel mot `data/employment-history.yaml` |

Semantik som är viktiga att känna till:

- `valid_to IS NULL` + `is_current = false` betyder **"slutdatum okänt"** - inte
  "pågående". `is_current = true` är den pågående tjänsten.
- Rader utan datum är värdefulla ("var på Sogeti") men bidrar **inte** till
  årssumman.
- `fn_documented_experience(person_id)` räknar **månader** ur daterad historia.
  Överlappande perioder slås ihop först - en konsult kan ha haft flera roller
  samtidigt, och en månad får inte räknas två gånger.
- `employment_competence` kopplar teknik till en *specifik* anställning
  ("vilken stack på CGI?"), till skillnad från `person_competence` som är
  personens samlade kompetens.

### Kurering

```bash
# 1. Halvautomatisk kandidering ur frölistans notes
python db/extract_employment_candidates.py > /tmp/employment-kandidater.yaml

# 2. Granska och skriv in i data/employment-history.yaml (med källa per rad)

# 3. Importera (idempotent - samma ref uppdateras, aldrig dupliceras)
uv run --with "psycopg[binary]" --with pyyaml python db/import_from_yaml.py \
    --file data/sundsvall-it-people.yaml
```

Regler för filen:

- Varje rad ska ha en `source` - den URL där uppgiften står.
- `confidence: low` betyder hypotes som ännu inte verifierats.
- Ny rad = ny `ref`. Ändrar du en rad: ändra samma `ref`.

### Varför det spelar roll

Filtret "minst 3 år i IT" bygger på `it_experience_years`. Utan dokumenterad
historia är 124 av 140 värden gissade ur rollnivån. Med historik kan fler bli
`documented` - och då är filtret en uppgift i stället för en gissning.
## 10. Uppdragsmatchning - rangordning av kandidater

`fn_match_candidates(p_profile uuid)` rankar kandidaterna mot en kravprofil
(`job_profile`). Poängen är alltid **delpoäng + förklaring**: beslutet ska
kunna förklaras och ifrågasättas, inte bara summeras.

### Kravprofilen

| Fält | Betydelse |
| --- | --- |
| `must_have` | Kompetenstaggar som krävs |
| `min_must_have` | Hur många av `must_have` som minst krävs (null = alla) |
| `nice_to_have` | Taggar som är meriterande |
| `min_seniority` | Lägsta rollnivå |
| `min_experience_years` | Lägsta antal år i IT |
| `required_location` / `accepted_locations` | Kravort och pendelorter |
| `required_languages` | Kravspråk |
| `available_by` | Senaste datum personen ska vara tillgänglig |
| `weights` | Vikter per del (jsonb) - justeras per uppdrag, ingen kodändring |

Kompetenser matchas mot både livslångsaggregatet (`person_competence`) och
tekniken under specifika anställningar (`employment_competence`).

### Delpoäng (0-100 per del, viktas till en total)

| Del | Vikt | Hur den räknas |
| --- | --- | --- |
| Must-have | 40 | Andel täckta taggar |
| Nice-to-have | 10 | Andel täckta taggar |
| Erfarenhet | 15 | Dokumenterad tid om den finns, annars angivet värde - mot kravet |
| Senioritet | 10 | 25 poäng per nivå under kravet; överkvalificering straffas inte |
| Ort | 10 | Kravort 100, pendelort 70, okänd ort 40, annan ort 0 |
| Språk | 5 | Täckta kravspråk; **ingen data ger neutrala 50**, aldrig 0 |
| Tillgänglighet | 5 | `available_from` före `available_by`; ingen data ger 50 |
| Datakonfidens | 5 | 60 % källdäckning + 40 % grund för erfarenhetsvärdet |

Delar som profilen inte styr är **inaktiva** och ingår inte i viktsumman -
en profil utan språkkrav straffar inte folk för saknad språkdata.

### Diskvalifiering

En kandidat är `eligible` om `must_covered >= min_must_have`. Saknas en
must-have hamnar kandidaten **under** de godkända i listan, med en förklaring
som säger vad som saknas. Den utesluts inte - en människa ska kunna se och
överskrida.

### Två lärdomar från mätning på den riktiga databasen

1. **Must-have ska normalt vara EN tagg.** "system_development +
   information_security + cloud" som krav gav högst 1 av 3 täckt - ingen
   kandidat blev godkänd. Vill man kräva flera taggar används
   `min_must_have`, t.ex. "minst 2 av 3".
2. **Poängen ensam diskriminerar dåligt.** Nästan alla kandidater har ort
   rätt och senioritet över krav, så poängen hamnade ihop (94 mot 88).
   Listan sorteras därför först på hur väl kravet täcks och sedan på
   poängen - se `order by` i funktionen.

### Användning

```sql
-- lista profiler
select id, slug, title, must_have, min_must_have from job_profile;

-- rankad lista med förklaring
select score, full_name, organization, array_to_string(explanation, E'\n  - ')
from fn_match_candidates('PROFIL-ID'::uuid)
where eligible;
```

Driftfrågorna 28-33 i `queries.sql` har färdiga varianter. Testet:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_match.sql
```

Exempelprofilen `exempel-systemutvecklare` skapas av `schema.sql` (idempotent
på `slug`) och används för att prova vikterna.
