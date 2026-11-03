# Neon i dev-miljön

Det finns **ingen databas i klustret**. Dev pratar direkt mot samma
Neon/Lakebase Postgres som resten av pappa (EU-regionen, branch `production`).

## Så här sätts det upp

```bash
./sync-env.sh          # genererar neon.env ur src/neon/.env.local
```

`neon.env` gitignoras. `kustomize build` och `tilt up` kräver att den finns -
kör `sync-env.sh` först.

Skapa `src/neon/.env.local` om den saknas:

```bash
cd ../../.. && npm run neon:env
```

## Vad som händer i klustret

`kustomization.yaml` genererar en Secret `pappa-neon-db` med två nycklar:

| Nyckel | Endpoint | Används av |
| --- | --- | --- |
| `DATABASE_URL` | poolad (`-pooler`, PgBouncer) | Nuxt-podden (`NUXT_DATABASE_URL`) |
| `DATABASE_URL_UNPOOLED` | direkt | migrations/dump om någon kör psql i podden |

Secreten refereras från `base/nuxt-deployment.yaml`, så samma Secret-namn
gäller i alla miljöer (`prod` skapar den externt, se `environments/prod/neon/`).

## Schema

Schemat appliceras **utanifrån klustret**, inte av Atlas:

```bash
npm run db:migrate   # db/schema.sql mot den direkta Neon-endpointen
```

`environments/base/db` (Atlas-operator) är borttaget - pappas schema lever i
`db/schema.sql`, inte i ett CRD.

## Om pekar dev mot en egen Neon-branch

`neon.env` pekar som standard mot `production`-branchen. Vill du en egen
branch:

```bash
cd ../../../../src/neon && neon checkout dev
npm run neon:env      # hämtar den nya branchens env
cd ../../environments/dev/neon && ./sync-env.sh
```

Observera: `src/neon/neon.ts` ger nya icke-default-branchar `ttl: "7d"`, så
branchen försvinner efter en vecka och måste skapas om.
