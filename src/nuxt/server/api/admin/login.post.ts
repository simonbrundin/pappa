import { ADMIN_COOKIE, createAdminSession, resolveAdminToken, safeEqual } from '../../utils/admin'

/**
 * Logga in som admin.
 *
 * Lösenordet skickas i requestens kropp (aldrig i URL:en) och byts mot
 * en httpOnly-cookie. Webbläsaren behåller alltså inte lösenordet - bara
 * ett signerat sessionsvärde som servern själv har skapat.
 *
 * Lösenordet är samma hemlighet som `NUXT_ADMIN_TOKEN` (den används
 * även som HMAC-nyckel för sessionen), så det finns bara en sak att
 * hålla koll på. Sätts i appens miljö - se scripts/admin-token.sh.
 */
export default defineEventHandler(async (event) => {
  const password = resolveAdminToken()

  if (!password) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Admin-lösenord saknas',
      message: 'Sätt NUXT_ADMIN_TOKEN i appens miljö för att kunna logga in som admin.',
    })
  }

  const body = await readBody<{ password?: string }>(event)
  const provided = (body?.password ?? '').trim()

  if (!provided || !safeEqual(provided, password)) {
    throw createError({ statusCode: 401, statusMessage: 'Obehörig', message: 'Fel admin-lösenord.' })
  }

  setCookie(event, ADMIN_COOKIE, createAdminSession(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
    // Secure bara när anslutningen faktiskt är krypterad - annars släpper
    // webbläsaren cookien i dev (port-forward via http) och sessionen
    // försvinner direkt.
    secure: isSecureRequest(event),
  })

  return { ok: true }
})

/** Är förfrågan kommit över https (eller via en https-proxy)? */
function isSecureRequest(event: Parameters<typeof getHeader>[0]): boolean {
  const forwarded = getHeader(event, 'x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https'
  return Boolean((event.node.req as { encrypted?: boolean }).encrypted)
}
