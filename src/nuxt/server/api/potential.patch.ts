import { getDb } from '../utils/db'
import { requireAdmin } from '../utils/requireAdmin'
import { DEFAULT_REVIEW_MONTHS } from '#shared/utils/potential'
import type { PotentialResult, PotentialUpdate } from '#shared/types/people'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Dagens datum i UTC - jämförs mot genomgångsdatumet. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Är värdet ett verkligt datum (2026-02-30 är det inte)? */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return false
  return date.toISOString().slice(0, 10) === value
}

/**
 * Sätt en kandidat som aktuell eller parkrad.
 *
 * Parkering innebär "inte aktuell NU" - t.ex. en konsult som driver eget
 * bolag och kanske vill anställas igen om ett halvår. Därför sparar vi
 * både skälet och datumet för nästa genomgång, så att personen syns igen
 * i "Ej aktuella nu" när det är dags att se över den.
 *
 * Kräver adminsession - samma modell som pipen och kravprofilerna.
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event)

  const body = await readBody<PotentialUpdate>(event)
  if (!body?.person_id || !UUID.test(body.person_id)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Personen saknas eller har ogiltigt id.',
    })
  }
  if (typeof body.is_potential !== 'boolean') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'is_potential måste vara sant eller falskt.',
    })
  }

  const sql = getDb()

  let reason: string | null = null
  let reviewAt: string | null = null

  if (!body.is_potential) {
    reason = body.not_relevant_reason?.trim() || 'Ej aktuell just nu'

    const requested = body.potential_review_at?.trim()
    if (requested) {
      if (!isRealDate(requested)) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Felaktig begäran',
          message: 'Genomgångsdatumet måste vara ett giltigt datum (åååå-mm-dd).',
        })
      }
      if (requested < today()) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Felaktig begäran',
          message: 'Genomgångsdatumet kan inte ligga i det förflutna.',
        })
      }
      reviewAt = requested
    } else {
      // Default: om DEFAULT_REVIEW_MONTHS månader.
      const fallback = new Date()
      fallback.setMonth(fallback.getMonth() + DEFAULT_REVIEW_MONTHS)
      reviewAt = fallback.toISOString().slice(0, 10)
    }
  }

  const [row] = await sql<PotentialResult[]>`
    update person
       set is_potential = ${body.is_potential},
           not_relevant_reason = ${reason},
           potential_review_at = ${reviewAt}
     where id = ${body.person_id}::uuid
    returning id,
              is_potential,
              not_relevant_reason,
              potential_review_at::text as potential_review_at
  `

  if (!row) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Personen finns inte i databasen.',
    })
  }

  // Med i loggen så att det går att se varför en kandidat parkades.
  await sql`
    insert into audit_log (actor, action, table_name, row_id, detail)
    values (
      'admin',
      ${body.is_potential ? 'potential.reactivated' : 'potential.parked'},
      'person',
      ${row.id},
      ${sql.json({ reason, review_at: reviewAt })}
    )
  `

  return row
})
