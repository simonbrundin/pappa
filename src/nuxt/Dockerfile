# syntax=docker/dockerfile:1
#
# Nuxt 4-appen för pappa (Nuxt server + SSR). Server-side rendering och
# /api/people kräver Node - inte en statisk nginx-SPA som i repo-template.
#
#   docker build -t nuxt-app:latest src/nuxt
#
# Databasen är Neon (Lakebase Postgres) och nås via NUXT_DATABASE_URL,
# se environments/base/nuxt-deployment.yaml.

# =============================================================================
# Build
# =============================================================================
FROM node:22-alpine AS build

WORKDIR /app

# Installera beroenden först - lagras cached så länge lockfilen är oförändrad.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# =============================================================================
# Runtime
# =============================================================================
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=80

COPY --from=build /app/.output ./.output

EXPOSE 80

CMD ["node", ".output/server/index.mjs"]
