import { timingSafeEqual } from 'node:crypto'
import { getDb } from '../../utils/db'

interface MergeBody {
  /** Den ena posten i paret. */
  a_id?: string
  /** Den andra posten i paret. */
  b_id?: string
  /** Vilken som ska behållas: 'a' eller 'b'. Utan det väljs den rikare posten. */
  keep?: 'a' | 'b'
}

/**
 * Slå ihop två poster om samma person.
 *
 * SKRIVNING - kräver admin-token (NUXT_ADMIN_TOKEN). Utan den skulle
 * endpointen vara en publik knapp som raderar personer ur masterdatabasen,
 * vilket är samma problem som en publik kontaktloggning.
 *
 * Semantik (se fn_merge_people):
 *   - Kopplingar (källor, kompetenser, anställningar, bevakningslista,
 *     kontaktlogg) flyttas till posten som behålls.
 *   - Tomma fält på den behållna posten fylls från den raderade.
 *   - Den raderade postens external_id registreras i person_merge, så att
 *     frölistan inte skapar tillbaka dubbletten vid nästa import.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const token = config.adminToken

  if (!token) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Admin-token saknas',
      message:
        'Sätt NUXT_ADMIN_TOKEN i appens miljö för att kunna slå ihop dubbletter. ' +
        'Utan token är sammanslagning avsiktligt avstängd.',
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

  const body = await readBody<MergeBody>(event)
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

  // Välj vilken post som behålls. Utan explicit val behålls den rikare
  // posten (flest källor och anställningsrader), med dokumenterad erfarenhet
  // och external_id som tiebreak - så att valet är deterministiskt.
  const [choice] = await sql<{ keep_id: string; drop_id: string; kept_name: string }[]>`
    with pair_posts as (
      select id,
             full_name,
             (select count(*) from person_source ps where ps.person_id = p.id)::int
           + (select count(*) from person_employment e where e.person_id = p.id)::int as rikedom,
             coalesce(it_experience_years, 0) as ar,
             external_id
        from person p
       where p.id in (${aId}::uuid, ${bId}::uuid)
    )
    select keep_p.id as keep_id,
           drop_p.id as drop_id,
           keep_p.full_name as kept_name
      from pair_posts keep_p
      join pair_posts drop_p on drop_p.id <> keep_p.id
     order by
       case when ${body?.keep ?? null}::text = 'a' and keep_p.id = ${aId}::uuid then 0
            when ${body?.keep ?? null}::text = 'b' and keep_p.id = ${bId}::uuid then 0
            else 1 end,
       keep_p.rikedom desc, keep_p.ar desc, keep_p.external_id
     limit 1
  `

  if (!choice) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Hittade inte posterna i paret.',
    })
  }

  const [result] = await sql<{ summary: Record<string, unknown> }[]>`
    select fn_merge_people(${choice.keep_id}::uuid, ${choice.drop_id}::uuid, ${actor}) as summary
  `

  return {
    ok: true,
    kept_id: choice.keep_id,
    kept_name: choice.kept_name,
    ...(result?.summary ?? {}),
  }
})

/** Jämför två strängar utan att avslöja längdskillnaden i tiden. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
