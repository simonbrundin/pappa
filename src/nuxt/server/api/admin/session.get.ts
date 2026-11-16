import { ADMIN_COOKIE, verifyAdminSession } from '../../utils/admin'

/**
 * Status för adminsessionen.
 *
 * Används av UI:t för att veta om skrivning är tillåten - tokenen
 * själv lämnar aldrig servern.
 */
export default defineEventHandler((event) => {
  const authenticated = verifyAdminSession(getCookie(event, ADMIN_COOKIE))
  return { authenticated }
})
