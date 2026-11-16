import { resolveAdminToken, safeEqual, verifyAdminSession, ADMIN_COOKIE } from './admin'

/**
 * Kräver admin-rättigheter för skrivning.
 *
 * Godkänns på två sätt:
 *   1. En giltig adminsession (httpOnly-cookie, satt vid inloggning på /admin).
 *   2. Rätt admin-lösenord i headern `x-admin-token` - för CLI:er och
 *      skript som inte har en webbläsare.
 *
 * Utan lösenord är skrivning avstängd (503), med fel uppgifter 401.
 */
export function requireAdmin(event: Parameters<typeof getHeader>[0]): void {
  const token = resolveAdminToken()

  if (!token) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Admin-lösenord saknas',
      message:
        'Sätt NUXT_ADMIN_TOKEN i appens miljö för att kunna skriva mot pipen.',
    })
  }

  // Sessionen är den vanliga vägen i webbläsaren.
  if (verifyAdminSession(getCookie(event, ADMIN_COOKIE))) return

  // Headertokenen är för CLI:er och skript.
  const provided = getHeader(event, 'x-admin-token') ?? ''
  if (provided && safeEqual(provided, token)) return

  throw createError({
    statusCode: 401,
    statusMessage: 'Obehörig',
    message: 'Ingen giltig adminsession - logga in på /admin.',
  })
}
