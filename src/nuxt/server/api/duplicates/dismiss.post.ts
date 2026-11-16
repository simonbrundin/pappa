import { getDb } from '../../utils/db'
import { requireAdmin } from '../../utils/requireAdmin'

interface DismissBody {
  a_id?: string
  b_id?: string
  note?: string
}

/**
 * Markera ett par som "behåll båda" - de är INTE samma person.
 *
 * Registreras i duplicate_dismissal och paret utesluts sedan ur
 * kandidatlistan, så att samma par inte behöver granskas igen.
 *
 * Skrivning - kräver admin-token (NUXT_ADMIN_TOKEN).
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event)

  const body = await readBody<DismissBody>(event)
  const aId = body?.a_id
  const bId = body?.b_id

  if (!aId || !bId || aId === bId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Både a_id och b_id måste anges och vara olika.',
    })
  }

  const sql = getDb()
  const actor = getHeader(event, 'x-admin-actor') || 'ui'

  await sql`
    insert into duplicate_dismissal (person_a_id, person_b_id, actor, note)
    values (${aId}::uuid, ${bId}::uuid, ${actor}, ${body?.note ?? null})
    on conflict (person_a_id, person_b_id) do update
      set dismissed_at = now(), actor = excluded.actor
  `

  return { ok: true, a_id: aId, b_id: bId }
})
