import { createHmac, timingSafeEqual } from 'node:crypto'
import { readLocalEnvValue } from './env'

/**
 * Admin-lösenord för skrivning mot masterdatabasen.
 *
 * Krävs för att slå ihop dubbletter och för att spara kravprofiler.
 * Utan lösenord är skrivning avstängd (503) - appen startar ändå.
 *
 * Sökordning:
 *   1. runtimeConfig (NUXT_ADMIN_TOKEN i podens miljö)
 *   2. process.env
 *   3. lokal .env-fil (src/nuxt/.env) - samma mönster som DATABASE_URL
 *
 * Samma värde används som admin-lösenord i UI:t och som HMAC-nyckel för
 * sessionen, så det finns bara en hemlighet att hålla koll på.
 * Lösenordet skapas med `npm run admin:token` och får aldrig committas.
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

/** Namn på cookien som håller adminsessionen. */
export const ADMIN_COOKIE = 'pappa_admin_session'

/** Hur länge en adminsession gäller (sekunder). */
const ADMIN_SESSION_TTL = 7 * 24 * 60 * 60

/**
 * Skapa en adminsession.
 *
 * Värdet är "utgångsstämpel.HMAC" där HMAC-nyckeln är admin-lösenordet.
 * Serverhemligheten syns aldrig i webbläsaren - bara ett signerat värde
 * i en httpOnly-cookie, som inte går att härleda lösenordet ur.
 *
 * Gammastämpel + HMAC(timestamp) - HMAC:n binder tiden så att
 * cookien inte kan spelas in med en gammal utgångsstämpel.
 */
export function createAdminSession(): string {
  const token = resolveAdminToken()
  const expires = String(Date.now() + ADMIN_SESSION_TTL * 1000)
  return `${expires}.${sign(expires, token)}`
}

/**
 * Verifiera en adminsession. Returnerar false om den är trasig,
 * utgången eller signerad med fel nyckel.
 */
export function verifyAdminSession(value: string | undefined): boolean {
  if (!value) return false
  const token = resolveAdminToken()
  if (!token) return false

  const [expiresRaw, signature] = value.split('.')
  if (!expiresRaw || !signature) return false

  const expires = Number(expiresRaw)
  if (!Number.isFinite(expires) || expires < Date.now()) return false

  return safeEqual(signature, sign(expiresRaw, token))
}

/** HMAC över värdet, med admin-lösenordet som nyckel. */
function sign(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex')
}
