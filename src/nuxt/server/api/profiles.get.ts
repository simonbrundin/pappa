import { getDb } from '../utils/db'
import type { JobProfile, ProfilesResponse } from '#shared/types/people'

/**
 * Kravprofiler för uppdrag.
 *
 * Läsning är publik - det är samma slags uppgifter som /api/people visar,
 * och en kravprofil innehåller inga personuppgifter.
 * Skrivning (POST /api/profiles) kräver admin-token.
 */
export default defineEventHandler(async () => {
  const sql = getDb()

  const rows = await sql<JobProfile[]>`
    select
      id,
      slug,
      title,
      client_name,
      notes,
      must_have,
      min_must_have,
      nice_to_have,
      min_seniority,
      min_experience_years,
      required_location,
      accepted_locations,
      required_languages,
      available_by,
      weights
    from job_profile
    order by created_at desc
  `

  return { profiles: rows } satisfies ProfilesResponse
})
