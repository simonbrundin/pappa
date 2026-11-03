# Neon i prod

Prod kör mot samma Neon/Lakebase Postgres (EU-regionen, branch `production`).
Det finns ingen databas i klustret.

## Secret

`base/nuxt-deployment.yaml` refererar till Secret `pappa-neon-db` med nyckeln
`DATABASE_URL`. Den skapas **externt** - aldrig ur en fil i repot:

```bash
kubectl -n repo-template create secret generic pappa-neon-db \
  --from-literal=DATABASE_URL="$(grep '^DATABASE_URL=' src/neon/.env.local | cut -d= -f2-)" \
  --from-literal=DATABASE_URL_UNPOOLED="$(grep '^DATABASE_URL_UNPOOLED=' src/neon/.env.local | cut -d= -f2-)"
```

Flux kan göra samma sak med en `ExternalSecret` mot en secret store.

## Schema

Appliceras utanifrån klustret:

```bash
npm run db:migrate
```

## Vad som ändrades 2026-11-02

- `base/db` (Atlas-operator + `repo-template`-schemat) togs bort. Schemat för
  pappa ligger i `db/schema.sql` och appliceras av `db/migrate.sh` - inte av
  ett CRD i klustret.
- `go-api` togs bort ur base. pappa har ingen Go-tjänst; Nuxt pratar direkt
  med Postgres via `/api/people`.
