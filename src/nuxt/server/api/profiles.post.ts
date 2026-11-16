import { getDb } from '../utils/db'
import { requireAdmin } from '../utils/requireAdmin'

interface ProfileBody {
  id?: string
  slug?: string
  title?: string
  client_name?: string | null
  notes?: string | null
  must_have?: string[]
  min_must_have?: number | null
  nice_to_have?: string[]
  min_seniority?: string | null
  min_experience_years?: number | null
  required_location?: string | null
  accepted_locations?: string[]
  required_languages?: string[]
  available_by?: string | null
  weights?: Record<string, number>
}

const SENIORITIES = ['junior', 'mid', 'senior', 'lead', 'chef', 'cxo'] as const

/**
 * Skapa eller uppdatera en kravprofil.
 *
 * Skrivning mot databasen - kräver admin-token, precis som
 * dubblettsammanslagningen. En kravprofil styr vilka kandidater som
 * rankas, så en öppen write-endpoint skulle kunna styra listan.
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event)

  const body = await readBody<ProfileBody>(event)
  if (!body?.title?.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Profilen behöver en titel.',
    })
  }

  if (body.min_seniority && !SENIORITIES.includes(body.min_seniority as never)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: `Okänd senioritetsnivå: ${body.min_seniority}`,
    })
  }

  const sql = getDb()

  const mustHave = cleanTags(body.must_have)
  const niceToHave = cleanTags(body.nice_to_have)
  const acceptedLocations = cleanTags(body.accepted_locations)
  const requiredLanguages = cleanTags(body.required_languages)

  // min_must_have får inte överstiga antalet krav.
  const minMustHave =
    body.min_must_have === null || body.min_must_have === undefined
      ? null
      : Math.max(1, Math.min(body.min_must_have, mustHave.length || 1))

  const weights = body.weights ?? {}

  if (body.id) {
    const [updated] = await sql`
      update job_profile
         set title = ${body.title.trim()},
             client_name = ${body.client_name ?? null},
             notes = ${body.notes ?? null},
             must_have = ${mustHave},
             min_must_have = ${minMustHave},
             nice_to_have = ${niceToHave},
             min_seniority = ${body.min_seniority ?? null},
             min_experience_years = ${body.min_experience_years ?? null},
             required_location = ${body.required_location ?? null},
             accepted_locations = ${acceptedLocations},
             required_languages = ${requiredLanguages},
             available_by = ${body.available_by ?? null},
             weights = ${sql.json(weights)},
             updated_at = now()
       where id = ${body.id}::uuid
       returning id
    `
    if (!updated) {
      throw createError({ statusCode: 404, statusMessage: 'Hittades inte', message: 'Profilen finns inte.' })
    }
    return { ok: true, id: updated.id }
  }

  const slug = body.slug?.trim() || slugify(body.title)
  const [created] = await sql`
    insert into job_profile
      (slug, title, client_name, notes, must_have, min_must_have, nice_to_have,
       min_seniority, min_experience_years, required_location, accepted_locations,
       required_languages, available_by, weights)
    values
      (${slug}, ${body.title.trim()}, ${body.client_name ?? null}, ${body.notes ?? null},
       ${mustHave}, ${minMustHave}, ${niceToHave},
       ${body.min_seniority ?? null}, ${body.min_experience_years ?? null},
       ${body.required_location ?? null}, ${acceptedLocations},
       ${requiredLanguages}, ${body.available_by ?? null}, ${sql.json(weights)})
    on conflict (slug) do update
      set title = excluded.title,
          client_name = excluded.client_name,
          notes = excluded.notes,
          must_have = excluded.must_have,
          min_must_have = excluded.min_must_have,
          nice_to_have = excluded.nice_to_have,
          min_seniority = excluded.min_seniority,
          min_experience_years = excluded.min_experience_years,
          required_location = excluded.required_location,
          accepted_locations = excluded.accepted_locations,
          required_languages = excluded.required_languages,
          available_by = excluded.available_by,
          weights = excluded.weights,
          updated_at = now()
    returning id
  `

  if (!created) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Kunde inte spara',
      message: 'Profilen kunde inte skapas.',
    })
  }

  return { ok: true, id: created.id }
})

/** Tar bort tomma taggar och dubbletter. */
function cleanTags(tags?: string[]): string[] {
  if (!tags) return []
  return [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))]
}

/** URL-vänlig nyckel ur titeln. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}
