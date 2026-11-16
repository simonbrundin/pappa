/**
 * API för de sparade Kameo-underlagen.
 *
 * GET /api/kameo/interest-payments - lista sparade ränteutbetalningar.
 */

import { listInterestPayments } from '../../utils/mail/kameo-interest-store'

export default defineEventHandler(async () => {
  const payments = await listInterestPayments()
  return { payments }
})
