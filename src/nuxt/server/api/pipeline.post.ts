import { getDb } from '../utils/db'
import { requireAdmin } from '../utils/requireAdmin'

const STAGES = [
  'sourced',
  'teams_check',
  'review',
  'contacted',
  'lunch',
  'paper',
  'hired',
  'dropped',
] as const

const SOURCES = [
  'linkedin',
  'arbetsforrmedlingen',
  'boolag',
  'myndighet',
  'it_bolag_sundsvall',
  'soulmate_kontakt',
  'annat',
] as const

type Stage = (typeof STAGES)[number]
type Source = (typeof SOURCES)[number]

interface PipelineBody {
  op?: 'create' | 'move' | 'update' | 'drop'
  id?: string
  person_id?: string
  role_label?: string
  source?: Source
  source_note?: string | null
  owner_id?: string | null
  note?: string | null
  stage?: Stage
  actor?: string | null
  reason?: string
  /** true = kandidaten säger nej -> do_not_contact sätts. */
  no_contact?: boolean
}

/**
 * Skriva mot pipen. Kräver admin-token - samma modell som kravprofiler och
 * dubblettsammanslagning.
 *
 * Varje stage-flytt loggas i pipeline_event (vem, när, varför), så att
 * flödet går att följa i efterhand.
 */
export default defineEventHandler(async event => {
  requireAdmin(event)

  const body = await readBody<PipelineBody>(event)
  const sql = getDb()

  if (body.op === 'create') {
    const personId = body.person_id
    if (!personId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: 'Personen saknas.',
      })
    }

    const role = body.role_label?.trim() || 'Okänd roll'
    const source: Source = body.source ?? 'annat'

    const [row] = await sql<{ id: string }[]>`
      insert into candidate_pipeline (person_id, role_label, stage, source, source_note, owner_id, note)
      values (${personId}::uuid, ${role}, 'sourced', ${source},
              ${body.source_note ?? null}, ${body.owner_id ?? null}::uuid, ${body.note ?? null})
      on conflict (person_id, role_label) do update
         set stage = 'sourced',
             source = excluded.source,
             source_note = excluded.source_note,
             owner_id = excluded.owner_id,
             note = excluded.note,
             drop_reason = null,
             entered_stage_at = now()
      returning id
    `

    if (!row) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Kunde inte spara',
        message: 'Kortet kunde inte skapas.',
      })
    }

    await sql`
      insert into pipeline_event (pipeline_id, from_stage, to_stage, actor, note)
      values (${row.id}::uuid, null, 'sourced', ${body.actor ?? null}, ${body.note ?? null})
    `

    return { ok: true, id: row.id }
  }

  if (body.op === 'move') {
    const stage = body.stage
    if (!stage || !STAGES.includes(stage)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: `Okänt steg: ${stage ?? '(saknas)'}`,
      })
    }
    if (!body.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: 'Kortet saknas.',
      })
    }

    // from_stage måste läsas FÖRE uppdateringen - annars loggar vi
    // "från dropped till dropped".
    const [row] = await sql<{ id: string; from_stage: Stage }[]>`
      with prev as (
        select id, stage as from_stage
          from candidate_pipeline
         where id = ${body.id}::uuid
      )
      update candidate_pipeline cp
         set stage = ${stage}::pipeline_stage,
             entered_stage_at = now(),
             drop_reason = case when ${stage}::pipeline_stage = 'dropped' then ${body.reason ?? null} else null end
        from prev
       where cp.id = prev.id
      returning cp.id, prev.from_stage
    `

    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Hittades inte',
        message: 'Kortet finns inte.',
      })
    }

    await sql`
      insert into pipeline_event (pipeline_id, from_stage, to_stage, actor, note)
      values (${body.id}::uuid, ${row.from_stage}::pipeline_stage, ${stage}::pipeline_stage,
              ${body.actor ?? null}, ${body.note ?? null})
    `

    if (stage === 'hired') {
      await sql`
        update person
           set contact_state = 'hired'
         where id = (select person_id from candidate_pipeline where id = ${body.id}::uuid)
      `
    }

    return { ok: true, id: body.id }
  }

  if (body.op === 'update') {
    if (!body.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: 'Kortet saknas.',
      })
    }

    const [row] = await sql<{ id: string }[]>`
      update candidate_pipeline
         set role_label = coalesce(${body.role_label ?? null}, role_label),
             source = coalesce(${body.source ?? null}::pipeline_source, source),
             source_note = ${body.source_note ?? null},
             owner_id = ${body.owner_id ?? null}::uuid,
             note = ${body.note ?? null}
       where id = ${body.id}::uuid
      returning id
    `

    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Hittades inte',
        message: 'Kortet finns inte.',
      })
    }

    return { ok: true, id: row.id }
  }

  if (body.op === 'drop') {
    if (!body.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: 'Kortet saknas.',
      })
    }

    const reason = body.reason?.trim() || 'Okänd orsak'

    const [row] = await sql<{ id: string; from_stage: Stage }[]>`
      with prev as (
        select id, stage as from_stage
          from candidate_pipeline
         where id = ${body.id}::uuid
      )
      update candidate_pipeline cp
         set stage = 'dropped',
             drop_reason = ${reason},
             entered_stage_at = now()
        from prev
       where cp.id = prev.id
      returning cp.id, prev.from_stage
    `

    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Hittades inte',
        message: 'Kortet finns inte.',
      })
    }

    await sql`
      insert into pipeline_event (pipeline_id, from_stage, to_stage, actor, note)
      values (${row.id}::uuid, ${row.from_stage}::pipeline_stage, 'dropped'::pipeline_stage,
              ${body.actor ?? null}, ${reason})
    `

    if (body.no_contact) {
      await sql`
        update person
           set do_not_contact = true,
               contact_state = 'rejected'
         where id = (select person_id from candidate_pipeline where id = ${body.id}::uuid)
      `
    }

    return { ok: true, id: body.id }
  }

  throw createError({
    statusCode: 400,
    statusMessage: 'Felaktig begäran',
    message: `Okänd operation: ${body.op ?? '(saknas)'}`,
  })
})
