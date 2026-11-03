import { getDb } from '../utils/db'
import type { DuplicateCandidate, DuplicateSide, DuplicatesResponse } from '#shared/types/people'

/**
 * Dubblettkandidater - par som bör granskas av en människa.
 *
 * TVÅ NIVÅER:
 *   - `candidates` (starka): samma e-post, samma telefon, identiskt namn
 *     eller både förnamn OCH efternamn stämmer. Kan slås ihop.
 *   - `weak` (svaga): bara ett förnamn eller ett efternamn stämmer.
 *     Nästan alltid olika personer - "Mikael Gidlund" och "Mikael Nordlund"
 *     har ett gemensamt förnamn, "Gert" och "Robert Söderberg" ett gemensamt
 *     efternamn. De går att markera som "behåll båda", men inte att slå ihop.
 *
 * Listan är ett FÖRSLAG, aldrig ett svar. Läsning kräver ingen
 * autentisering - det är samma personuppgifter som /api/people redan visar.
 * Det är SKRIVNINGEN som är skyddad.
 */
export default defineEventHandler(async () => {
  const sql = getDb()

  const rows = await sql<DuplicateCandidate[]>`
    select
      id_a,
      id_b,
      name_a,
      name_b,
      org_a,
      org_b,
      title_a,
      title_b,
      email_a,
      email_b,
      phone_a,
      phone_b,
      similarity,
      same_org,
      same_email,
      same_phone,
      shared_competences,
      signal,
      score,
      given_kind,
      family_kind,
      weak
    from fn_duplicate_candidates(0.45, true)
  `

  // Antal anställningsrader och källor per person - granskaren behöver se
  // vad som faktiskt flyttas vid en sammanslagning.
  const counts = await sql<{ person_id: string; employments: number; sources: number }[]>`
    select p.id as person_id,
           (select count(*) from person_employment e where e.person_id = p.id)::int as employments,
           (select count(*) from person_source ps where ps.person_id = p.id)::int as sources
      from person p
     where p.id in (
       select id_a from fn_duplicate_candidates(0.45, true)
       union
       select id_b from fn_duplicate_candidates(0.45, true)
     )
  `
  const countByPerson = new Map(counts.map(c => [c.person_id, c]))

  const decorate = (row: DuplicateCandidate): DuplicateCandidate => {
    const side = (
      id: string,
      name: string,
      organization: string | null,
      title: string | null,
      email: string | null,
      phone: string | null,
    ): DuplicateSide => ({
      id,
      name,
      organization,
      title,
      email,
      phone,
      employments: countByPerson.get(id)?.employments ?? 0,
      sources: countByPerson.get(id)?.sources ?? 0,
    })
    return {
      ...row,
      a: side(row.id_a, row.name_a, row.org_a, row.title_a, row.email_a, row.phone_a),
      b: side(row.id_b, row.name_b, row.org_b, row.title_b, row.email_b, row.phone_b),
    }
  }

  const candidates = rows.filter(r => !r.weak).map(decorate)
  const weak = rows.filter(r => r.weak).map(decorate)

  return {
    candidates,
    weak,
    count: candidates.length,
    weakCount: weak.length,
  } satisfies DuplicatesResponse
})
