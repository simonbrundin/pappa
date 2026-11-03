import { getDb } from '../utils/db'
import type { JobProfile, MatchCandidate, MatchesResponse } from '#shared/types/people'

/**
 * Rankade kandidater mot en kravprofil.
 *
 * Poängen är alltid delpoäng + förklaring - läs förklaringen innan
 * någon kontaktas. Se db/README.md avsnitt 10 för matchningsregeln.
 *
 * GET /api/matches?profile=<uuid>
 */
export default defineEventHandler(async (event) => {
  const sql = getDb()
  const profileId = getQuery(event).profile

  if (typeof profileId !== 'string' || !profileId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Ange profile=<uuid>.',
    })
  }

  const [profile] = await sql<JobProfile[]>`
    select
      id, slug, title, client_name, notes, must_have, min_must_have,
      nice_to_have, min_seniority, min_experience_years, required_location,
      accepted_locations, required_languages, available_by, weights
    from job_profile
    where id = ${profileId}::uuid
  `

  if (!profile) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Hittades inte',
      message: 'Kravprofilen finns inte.',
    })
  }

  const candidates = await sql<MatchCandidate[]>`
    select
      person_id,
      full_name,
      title,
      organization,
      score,
      eligible,
      must_score,
      nice_score,
      experience_score,
      seniority_score,
      location_score,
      language_score,
      availability_score,
      confidence_score,
      documented_months,
      experience_years,
      experience_basis,
      seniority,
      location,
      must_covered,
      must_total,
      must_missing,
      nice_covered,
      nice_total,
      explanation
    from fn_match_candidates(${profileId}::uuid)
  `

  return {
    profile,
    candidates,
    eligibleCount: candidates.filter(c => c.eligible).length,
  } satisfies MatchesResponse
})
