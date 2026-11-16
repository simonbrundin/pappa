import { getDb } from '../../utils/db'
import { requireAdmin } from '../../utils/requireAdmin'

interface LinkBody {
  card_id?: string
  person_id?: string
}

/**
 * Länka ett omatchat Planner-kort till en person i registret.
 *
 * Automatisk matchning är ett förslag - när den missar är det en människa
 * som avgör. Manuel länkning vinner över automatik (match_kind = 'manual')
 * och överlever nästa import.
 */
export default defineEventHandler(async event => {
  requireAdmin(event)

  const body = await readBody<LinkBody>(event)
  if (!body.card_id || !body.person_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Kort och person måste anges.',
    })
  }

  const sql = getDb()

  const [card] = await sql<{ id: string }[]>`
    update planner_card
       set person_id = ${body.person_id}::uuid,
           match_kind = 'manual',
           match_score = 1
     where id = ${body.card_id}::uuid
    returning id
  `

  if (!card) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Kortet finns inte.',
    })
  }

  await sql`
    update candidate_pipeline cp
       set teams_ref = pc.external_id
      from planner_card pc
     where pc.person_id = cp.person_id
       and cp.stage <> 'dropped'
  `

  return { ok: true }
})
