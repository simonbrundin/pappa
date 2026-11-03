# pappa-web

Nuxt 4-app som läser masterdatabasen i Neon (Lakebase Postgres) och visar
alla kandidater.

## Kom igång

```bash
npm install
npm run dev          # http://localhost:3000
```

Databasen hittas automatiskt: om `NUXT_DATABASE_URL` (eller `DATABASE_URL`)
sätts används den, annars läses repots `src/neon/.env.local`.
För en egen uppsättning:

```bash
NUXT_DATABASE_URL="postgresql://..." npm run dev
```

## Arkitektur

| Fil | Roll |
| --- | --- |
| `server/utils/db.ts` | Delad `postgres.js`-anslutning mot Neon (poolad endpoint, `ssl: require`). Läser `src/neon/.env.local` som fallback. |
| `server/api/people.get.ts` | Server-endpoint som läser `person` + `organization` + `person_competence` + `person_source` och returnerar personer plus facetter (organisationer, kompetenser, orter, senioritet). |
| `shared/types/people.ts` | Typer som används av både server och klient. |
| `app/pages/index.vue` | Sidan: header, statistik, sök, filter, sortering, persongrid. |
| `app/components/PersonCard.vue` | Personkort med initialer, kompetenstaggar, kontaktknapp och källinformation. |

## Filteret "Minst N år i IT"

Filtreringen bygger på `person.it_experience_years` (minsta antal år personen
varit i IT). Värdet härleds i importen i tre steg, i prioritetsordning:

| Grund | Betyder | Antal (140 pers.) |
| --- | --- | --- |
| `explicit` | Angivet i `data/sundsvall-it-people.yaml` (källbelagt) | 12 |
| `documented` | Summan av daterad anställningshistorik | 0 just nu (4 har dokumenterad tid) |
| `notes` | Utvuxet ur notes-texten ("34 års erfarenhet") | 1 just nu |
| `seniority` | Unders gräns från rollnivå: cxo/chef 10, lead 6, senior 5, mid 3, junior 0 | 124 |
| – | Okänt (`null`) – räknas **aldrig** som "3+ år" | 3 |

Semantik i gränssnittet:

- Okänd erfarenhet (`null`) räknas inte som 3+ år. Sådana personer döljs när
  filtret är aktivt, och antalet redovisas ("3 med okänd erfarenhet dolda").
- Rollnivå-baserade värden är en **undre gräns**, inte ett facit - korten
  märks "(uppskattat)".

## CV-vyn i personkortet

Kortet har en utfällbar "CV & källa"-panel:

- **Anställningshistorik** - en rad per tjänst: arbetsgivare, roll,
  period ("2011–2017"), längd ("7 år"), typ (Anställd/Frilans/Konsult),
  teknik under perioden och länk till källan.
- Rader med `confidence: low` märks **osäker** - de är hypoteser.
- En pågående tjänst märks **Pågående**; en period utan slutdatum visas som
  "2018–" utan att antyda att den slutat.
- **Dokumenterad erfarenhet** visas vid erfarenhetsraden ("6,9 år dokumenterat")
  när `documented_months > 0`. Det är den del av erfarenheten som går att
  belägga med källa - till skillnad från rollnivå-gissningen.

Övriga filter: organisation, ort, senioritet, kompetens (grupperad per
kategori), sortering på dokumenterad erfarenhet samt kryssrutan "Endast med
dokumenterad erfarenhet".


## Dubblettknappen

Knappar "⇄ Dubbletter" i sidhuvudet öppnar en panel med par som MÅSTE granskas
av en människa. Panelen är ett **förslag**, aldrig ett svar - tre Söderberg på
samma konsultbolag är släktingar, inte dubbletter. Panelen kan också öppnas
direkt via `?duplicates=1` i URL:en.

### Två nivåer av kandidater

**Starka kandidater** kräver att *både* förnamn och efternamn stämmer (eller
att e-post/telefon är identiska). Namnet delas upp i förnamn och efternamn
och varje del jämförs separat:

| Utfall | Betydelse | Exempel |
|---|---|---|
| `exact` | Identiskt | "Anna" / "Anna" |
| `prefix` | Prefix, minst 4 tecken i den kortare delen | "lind" / "lindqvist" |
| `near` | 1-3 tecken fel, samma första bokstav | "anders" / "andreas" |
| `none` | Matchar inte | "gidlund" / "nordlund" |

Ett **gemensamt förnamn eller efternamn räcker inte**. "Mikael Gidlund" och
"Mikael Nordlund" har samma förnamn men olika efternamn - det är två
personer, inte en dubblett. Samma sak med "Gert Söderberg" och "Robert
Söderberg".

**Svaga par** (bara en namndel stämmer) visas i en egen utfällbar sektion
"par med bara ett gemensamt förnamn eller efternamn". De föreslås så att de
inte ska behöva upptäckas om och om igen, men där finns ingen
sammanslagsknapp - bara "Behåll båda".

### Två knappar per par

- **Slå ihop - behåll den här**: slår ihop paret och raderar den andra posten.
  Man väljer själv vilken post som behålls; utan val behålls den rikare
  posten (flest källor och anställningsrader).
- **Behåll båda - det är två olika personer**: registrerar paret i
  `duplicate_dismissal`, så att det inte visas igen.

### Vad som händer vid sammanslagning

- källor, kompetenser, anställningshistorik, bevakningslista och kontaktlogg
  flyttas till den behållna posten,
- tomma fält fylls från den raderade posten (befintliga värden skrivs aldrig
  över),
- högst **en** aktuell anställningsrad per person - den kuraterade raden
  (`ref is not null`) vinner,
- den raderade postens `external_id` registreras i `person_merge`, så att
  frölistan inte skapar tillbaka dubbletten vid nästa import.

Skrivning kräver **admin-token**. Sätt den i appens miljö:

```bash
NUXT_ADMIN_TOKEN="$(openssl rand -hex 24)" npm run app:dev
```

I klustret läses token från hemligheten `pappa-admin` (valfri - utan den är
sammanslagning avstängd och appen svarar 503):

```bash
kubectl -n pappa create secret generic pappa-admin \
  --from-literal=NUXT_ADMIN_TOKEN="$(openssl rand -hex 24)"
```

Token matas in i gränssnittet (lagras i `sessionStorage`, inte `localStorage`)
och skickas som `x-admin-token`.

### API

| Endpoint | Metod | Skydd | Beskrivning |
|---|---|---|---|
| `/api/duplicates` | GET | - | Dubblettkandidater: `candidates` (starka) och `weak` (svaga) |
| `/api/duplicates/merge` | POST | `x-admin-token` | Slår ihop ett par (`a_id`, `b_id`, valfritt `keep`: `a`/`b`) |
| `/api/duplicates/dismiss` | POST | `x-admin-token` | Markerar ett par som "behåll båda" (`a_id`, `b_id`) |
| `/api/profiles` | GET | - | Kravprofiler för uppdrag |
| `/api/profiles` | POST | `x-admin-token` | Skapa eller uppdatera en kravprofil |
| `/api/matches?profile=<uuid>` | GET | - | Rankade kandidater med delpoäng och förklaring |
| `/api/competences` | GET | - | Kompetenstaxonomin - förslag i kravformuläret |

## Vyn "Uppdrag"

`/uppdrag` (länk **"⬆ Uppdrag"** i kandidatlistans header) har två delar:
ett formulär för kravprofilen och den rankade listan.

Formuläret: titel, kund, must-have (taggar), "minst N av M", nice-to-have,
kravort, pendelorter, minsta senioritet, minsta antal år i IT och vikter per
del. Taggar väljs ur `GET /api/competences`, så en must-have är alltid en
riktig tagg.

Listan visar poäng, must-/nice-täckning och erfarenhetens grund. En kandidat
expanderas för att visa delpoängen per del och hela förklaringen. Kandidater
som inte täcker must-have hamnar under de godkända, inte borta.

Spara och uppdatera av profilen kräver admin-token (`x-admin-token`) - samma
token som dubblettsammanslagningen. Läsning och rankning är öppna, eftersom
det är samma uppgifter som kandidatlistan visar.

## GDPR i gränssnittet

E-post visas bara om `contact_published` är sant och personen inte är
märkt `do_not_contact`. Annars visas status i stället för kontaktuppgifter.
Käll-URL:er och `retention_until` syns först när kortet expanderas.

## Skript

```bash
npm run dev         # utvecklingsserver
npm run build       # produktionsbygge (.output/)
npm run preview     # kör produktionsbygget
npm run typecheck   # vue-tsc
```
