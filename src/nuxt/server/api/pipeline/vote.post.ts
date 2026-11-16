import { getDb } from '../../utils/db'
import { requireAdmin } from '../../utils/requireAdmin'

interface VoteBody {
  pipeline_id?: string
  voter_id?: string
  approved?: boolean
  note?: string | null
}

/**
 * Röst på granskningskortet.
 *
 * Varje kort har två röster: en anställd och en grundare. Båda måste vara
 * gröna för att kortet ska gå vidare till "kontaktad" - och en röd röst
 * innebär bortfall (med den som röstade som ansvarig).
 *
 * Vem som röstar identifieras via voter_id (namnlistan) - appen har ingen
 * inloggning, så röstaren väljer sitt namn.
 */
export default defineEventHandler(async event => {
  requireAdmin(event)

  const body = await readBody<VoteBody>(event)
  if (!body.pipeline_id || !body.voter_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Kort och rörare måste anges.',
    })
  }

  const approved = body.approved !== false
  const sql = getDb()

  const [voter] = await sql<{ id: string; name: string; role: 'employee' | 'founder' }[]>`
    select id, name, role
      from pipeline_voter
     where id = ${body.voter_id}::uuid and active
  `

  if (!voter) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Röraren finns inte eller är inaktiverad.',
    })
  }

  const [card] = await sql<{ id: string; person_id: string; stage: string }[]>`
    select id, person_id, stage
      from candidate_pipeline
     where id = ${body.pipeline_id}::uuid
  `

  if (!card) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Kortet finns inte.',
    })
  }

  await sql`
    insert into pipeline_vote (pipeline_id, voter_id, voter_role, approved, note)
    values (${card.id}::uuid, ${voter.id}::uuid, ${voter.role}::pipeline_voter_role,
            ${approved}, ${body.note ?? null})
    on conflict (pipeline_id, voter_role) do update
       set voter_id = excluded.voter_id,
           approved = excluded.approved,
           note = excluded.note,
           at = now()
  `

  // En röd röst = bortfall.
  if (!approved) {
    const reason = body.note?.trim() || `Neej av ${voter.name}`
    await sql`
      with prev as (
        select id, stage as from_stage
          from candidate_pipeline
         where id = ${card.id}::uuid
      )
      update candidate_pipeline cp
         set stage = 'dropped',
             drop_reason = ${reason},
             entered_stage_at = now()
        from prev
       where cp.id = prev.id
    `
    await sql`
      insert into pipeline_event (pipeline_id, from_stage, to_stage, actor, note)
      values (${card.id}::uuid, ${card.stage}::pipeline_stage, 'dropped'::pipeline_stage,
              ${voter.name}, ${reason})
    `
    return { ok: true, advanced: false, dropped: true }
  }

  // Båda röterna gröna -> kortet går vidare till "kontaktad".
  const approvals = await sql<{ voter_role: string; approved: boolean }[]>`
    select voter_role, approved from pipeline_vote
     where pipeline_id = ${card.id}::uuid and approved
  `

  const roles = new Set(approvals.map(row => row.voter_role))
  const ready = roles.has('employee') && roles.has('founder')

  if (ready && card.stage === 'review') {
    await sql`
      with prev as (
        select id, stage as from_stage
          from candidate_pipeline
         where id = ${card.id}::uuid
      )
      update candidate_pipeline cp
         set stage = 'contacted',
             entered_stage_at = now()
        from prev
       where cp.id = prev.id
    `
    await sql`
      insert into pipeline_event (pipeline_id, from_stage, to_stage, actor, note)
      values (${card.id}::uuid, 'review'::pipeline_stage, 'contacted'::pipeline_stage,
              ${voter.name}, 'Granskning godkänd av anställd och grundare')
    `
    return { ok: true, advanced: true, dropped: false }
  }

  return { ok: true, advanced: false, dropped: false }
})
