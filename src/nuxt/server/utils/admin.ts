import { timingSafeEqual } from 'node:crypto'
import { readLocalEnvValue } from './env'

/**
 * Admin-token för skrivning mot masterdatabasen.
 *
 * Krävs för att slå ihop dubbletter och för att spara kravprofiler.
 * Utan token är skrivning avstängd (503) - appen startar ändå.
 *
 * Sökordning:
 *   1. runtimeConfig (NUXT_ADMIN_TOKEN i podens miljö)
 *   2. process.env
 *   3. lokal .env-fil (src/nuxt/.env) - samma mönster som DATABASE_URL
 *
 * Token skapas med `npm run admin:token` och får aldrig committas.
 */
export function resolveAdminToken(): string {
  const config = useRuntimeConfig()
  const fromConfig = config.adminToken || process.env.NUXT_ADMIN_TOKEN
  if (fromConfig) return fromConfig

  return readLocalEnvValue('NUXT_ADMIN_TOKEN')
}

/**
 * Jämför två strängar utan att avslöja längdskillnaden i tiden.
 *
 * `timingSafeEqual` kräver lika långa buffertar, så en annan längd ger
 * falsk direkt i stället för en exception.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
