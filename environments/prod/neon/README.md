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

## Admin-token

Skrivning mot masterdatabasen (dubblettsammanslagning, kravprofiler) kräver
`NUXT_ADMIN_TOKEN`. Deploymenten läser den ur Secret `pappa-admin`
(`optional: true` - appen startar även utan token, men skrivning är då
avstängd).

Token skapas **utanför** repot och sätts i klustret:

```bash
npm run admin:token init                     # genererar token i src/nuxt/.env (gitignorad)
npm run admin:token apply repo-template      # skapar Secret pappa-admin
```

Token får aldrig committas. `src/nuxt/.env` är gitignorad och filen får
begränsade rättigheter (`600`).

I PR-miljön sätts token på samma sätt, i PR-ns:

```bash
npm run admin:token apply <pr-namespace>
```

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
