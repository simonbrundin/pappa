import { resolveAdminToken, safeEqual } from './admin'

/**
 * Kräver admin-token. Utan token är skrivning avstängd (503), med fel
 * token 401 - samma modell som dubblettsammanslagning och kravprofiler.
 */
export function requireAdmin(event: Parameters<typeof getHeader>[0]): void {
  const token = resolveAdminToken()

  if (!token) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Admin-token saknas',
      message:
        'Sätt NUXT_ADMIN_TOKEN i appens miljö för att kunna skriva mot pipen.',
    })
  }

  const provided = getHeader(event, 'x-admin-token') ?? ''
  if (!safeEqual(provided, token)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Obehörig',
      message: 'Fel admin-token.',
    })
  }
}
