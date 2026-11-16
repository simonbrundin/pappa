import { getDb } from '../utils/db'
import type { PlannerCard, PlannerResponse } from '#shared/types/pipeline'

interface CardRow {
  id: string
  external_id: string
  title: string
  bucket: string | null
  description: string | null
  person_id: string | null
  person_name: string | null
  match_score: number | null
  match_kind: string | null
  imported_at: string
}

/**
 * Korten ur Teams/Planner-listan "Rekrytering".
 *
 * Kort som matchat en person i registret ska inte behöva handas av en
 * människa - men matchningen är ett FÖRSLAG, inte ett svar, så varje kort
 * med låg poäng visas som omatchat och kan länkas manuellt.
 */
export default defineEventHandler(async (): Promise<PlannerResponse> => {
  const sql = getDb()

  const rows = await sql<CardRow[]>`
    select pc.id,
           pc.external_id,
           pc.title,
           pc.bucket,
           pc.description,
           pc.person_id,
           p.full_name as person_name,
           pc.match_score,
           pc.match_kind,
           pc.imported_at
      from planner_card pc
      left join person p on p.id = pc.person_id
     order by pc.match_score nulls last, pc.title
  `

  const cards: PlannerCard[] = rows

  return {
    cards,
    matched: cards.filter(c => c.person_id).length,
    unmatched: cards.filter(c => !c.person_id).length,
  }
})
