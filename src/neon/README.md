# Neon-integration

Allt som rör Neon/Lakebase Postgres ligger här. Applikationens egen datalager
(schema, import, driftfrågor) ligger i `db/`.

## Innehåll

| Fil | Syfte |
|---|---|
| `neon.ts` | Policy: vilka tjänster branchen ska ha. Läses av Neon CLI:et |
| `.neon` | CLI-kontext: vilket projekt och vilken branch (gitignoras) |
| `.env.local` | Neon-variablerna (gitignoras - innehåller lösenord) |
| `env.sh` | Laddar env-filen i shell: `DATABASE_URL` + `PPA_DIRECT_DATABASE_URL` |
| `env.py` | Samma sak för Python: `load_env()`, `direct_database_url()` |
| `pappa_db.py` | psycopg-anslutning + `retry()` vid tillfälliga fel |
| `package.json` | Neon CLI:ns beroenden (`@neon/config`, `@neon/env`) |

## Köra Neon-kommandon

CLI:et hittar `.neon` genom att söka **uppåt** från cwd, och letar `neon.ts`
*bredvid* `.neon`. Därför:

```bash
# från repo-roten (via npm - rekommenderat)
npm run neon:plan     # visa vad som skulle ändras
npm run neon:deploy   # applicera policyn + hämta env-variablerna
npm run neon:env      # hämta env-variablerna på egen hand

# eller direkt i katalogen
cd src/neon && neon deploy
```

`neon deploy` och `neon env pull` skriver `.env.local` i den här katalogen.

## Två anslutningar, två ändamål

Neon exponerar två endpoints för *samma* databas:

| Variabel | Endpoint | Används för |
|---|---|---|
| `DATABASE_URL` | poolad (`-pooler`, PgBouncer) | normal frågetrafik |
| `DATABASE_URL_UNPOOLED` | direkt | migrationer, `pg_dump`, restore |

Poolad endpoint = PgBouncer i transaktionsläge. Sessionstillstånd (`SET`,
`search_path`), SQL-nivå `PREPARE` och `pg_dump` fungerar **inte** där.
`db/migrate.sh`, `db/backup.sh` och `db/restore.sh` använder därför alltid den
direkta URL:en - de sätter `PPA_DIRECT_DATABASE_URL` via `env.sh`.

Se `db/README.md` för driftfrågorna och `concepts/poolad-eller-direkt-
anslutning-mot-neon` i wikin för resonemanget.
