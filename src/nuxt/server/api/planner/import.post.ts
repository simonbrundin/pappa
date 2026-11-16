import { getDb } from '../../utils/db'
import { requireAdmin } from '../../utils/requireAdmin'
import { guessColumns, parseCsv } from '../../utils/csv'

interface ImportBody {
  csv?: string
  name_col?: number
  org_col?: number
  desc_col?: number
  bucket_col?: number
}

/** Enkel hash - external_id behöver vara stabil mellan importer. */
function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i)
  return (h >>> 0).toString(16)
}

/**
 * Importera Planner-listan ("Rekrytering") från CSV.
 *
 * CSV används tills vi har Graph-behörighet i tenanten - samma
 * matchningsmotor används i båda fallen, bara källan skiljer sig.
 *
 * Matchningen är ett förslag: kort som inte hittar en person hamnar i
 * "omatchade" och kan länkas manuellt. Inga tysta felmatchningar.
 */
export default defineEventHandler(async event => {
  requireAdmin(event)

  const body = await readBody<ImportBody>(event)
  const csv = body.csv
  if (!csv?.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'CSV-filen saknas.',
    })
  }

  const { header, rows } = parseCsv(csv)
  if (!header.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'CSV-filen har ingen rubrikrad.',
    })
  }

  const guess = guessColumns(header)
  const nameCol = body.name_col ?? guess.name
  const orgCol = body.org_col ?? guess.org
  const descCol = body.desc_col ?? guess.description
  const bucketCol = body.bucket_col ?? guess.bucket

  if (nameCol < 0 || nameCol >= header.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Namnkolumnen finns inte i filen.',
    })
  }

  const sql = getDb()
  let imported = 0

  for (const row of rows) {
    const title = (row[nameCol] ?? '').trim()
    if (!title) continue

    const organization = orgCol >= 0 ? (row[orgCol] ?? '').trim() || null : null
    const description = descCol >= 0 ? (row[descCol] ?? '').trim() || null : null
    const bucket = bucketCol >= 0 ? (row[bucketCol] ?? '').trim() || null : null
    const externalId = `csv:${hash(`${title}|${organization ?? ''}`)}`

    await sql`
      insert into planner_card (external_id, title, bucket, description, organization, raw)
      values (${externalId}, ${title}, ${bucket}, ${description}, ${organization},
              ${sql.json({ row })})
      on conflict (external_id) do update
         set title = excluded.title,
             bucket = excluded.bucket,
             description = excluded.description,
             organization = excluded.organization,
             raw = excluded.raw,
             imported_at = now()
    `
    imported++
  }

  // Matchning mot registret. Endast kort som inte redan är länkade av en
  // människa - en manuell länkning ska inte röras av en ny import.
  await sql`
    with matched as (
      select pc.id, m.person_id, m.score, m.kind
        from planner_card pc
        join lateral fn_match_person(pc.title, pc.organization) m on true
       where pc.person_id is null
    )
    update planner_card pc
       set person_id = matched.person_id,
           match_score = matched.score,
           match_kind = matched.kind
      from matched
     where pc.id = matched.id
  `

  // Pipeline-kort som motsvarar ett Planner-kort märks - de är redan
  // rekryterade i teamets lista.
  await sql`
    update candidate_pipeline cp
       set teams_ref = pc.external_id
      from planner_card pc
     where pc.person_id = cp.person_id
       and cp.stage <> 'dropped'
       and cp.teams_ref is distinct from pc.external_id
  `

  const [matchedRow] = await sql<{ matched: number }[]>`
    select count(*)::int as matched from planner_card where person_id is not null
  `
  const [unmatchedRow] = await sql<{ unmatched: number }[]>`
    select count(*)::int as unmatched from planner_card where person_id is null
  `

  return {
    ok: true,
    imported,
    matched: matchedRow?.matched ?? 0,
    unmatched: unmatchedRow?.unmatched ?? 0,
  }
})
