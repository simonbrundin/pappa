# Neon i PR-miljön

PR-preview kör mot samma Neon/Lakebase Postgres som dev och prod.

## Lokalt

```bash
./sync-env.sh          # genererar pr.neon.env ur src/neon/.env.local
```

`pr.neon.env` gitignoras. `kustomize build` och Tilt kräver att den finns.

## I CI

`pr/kustomization.yaml` skrivs automatiskt av GitHub Actions. Om den filen
genereras om måste resursen `./neon` finnas med, annars saknas secreten
`pappa-neon-db` och podden startar inte:

```yaml
resources:
  - ../base
  - ./neon
  - httproute.yaml
```

Filen `pr.neon.env` skapas i jobbet ur ett GitHub secret - inte ur något
i repot:

```bash
echo "DATABASE_URL=${{ secrets.DATABASE_URL }}" > environments/pr/neon/pr.neon.env
echo "DATABASE_URL_UNPOOLED=${{ secrets.DATABASE_URL_UNPOOLED }}" >> environments/pr/neon/pr.neon.env
```

## Namn på servicen

`httproute.yaml` pekar på `nuxt-app-service` (base), inte `app` - det är
servicen som faktiskt finns.
