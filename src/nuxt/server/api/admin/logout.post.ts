import { ADMIN_COOKIE } from '../../utils/admin'

/**
 * Logga ut från adminsessionen.
 *
 * Cookien rensas - nästa skrivförsök kräver inloggning igen.
 */
export default defineEventHandler((event) => {
  deleteCookie(event, ADMIN_COOKIE, { path: '/' })
  return { ok: true }
})
