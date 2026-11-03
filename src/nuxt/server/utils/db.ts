import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { parseEnvFile } from './env'

let client: ReturnType<typeof postgres> | null = null

/**
 * Hittar DATABASE_URL. Prioriterar NUXT_DATABASE_URL / DATABASE_URL,
 * annars läser vi repots Neon-env-fil (src/neon/.env.local).
 */
function resolveDatabaseUrl(): string {
  const config = useRuntimeConfig()
  const fromConfig = config.databaseUrl || process.env.DATABASE_URL
  if (fromConfig) return fromConfig

  const candidates = [
    resolve(process.cwd(), '../neon/.env.local'),
    resolve(process.cwd(), '../../src/neon/.env.local'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const env = parseEnvFile(candidate)
    if (env.DATABASE_URL) return env.DATABASE_URL
  }

  throw new Error(
    'DATABASE_URL saknas. Sätt NUXT_DATABASE_URL eller lägg in en .env i src/nuxt.',
  )
}

/**
 * TLS-inställningar.
 *
 * Neon kräver TLS och har giltiga certifikat - där används 'verify-full',
 * vilket både krypterar och kontrollerar servercertifikat och värdnamn.
 * ('require' i postgres.js betyder kryptering UTAN kontroll av certifikatet.)
 *
 * Den lokala docker-compose-databasen har ingen TLS, så plaintext används
 * bara dit. Uttrycklig 'sslmode=disable' i URL:en vinner alltid.
 */
function resolveSsl(url: string): false | 'prefer' | 'verify-full' {
  const { hostname, searchParams } = new URL(url)
  const sslmode = searchParams.get('sslmode')
  if (sslmode === 'disable') return false
  if (sslmode === 'prefer' || sslmode === 'allow') return 'prefer'
  if (['localhost', '127.0.0.1', '::1'].includes(hostname.replace(/^\[|\]$/g, ''))) {
    return false
  }
  return 'verify-full'
}

/**
 * Delad Postgres-anslutning mot Neon. Använder den poolade endpointen
 * så att scale-to-zero inte startar databasen för varje sidvisning.
 */
export function getDb() {
  if (!client) {
    const url = resolveDatabaseUrl()
    client = postgres(url, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 15,
      ssl: resolveSsl(url),
      prepare: false,
    })
  }
  return client
}
