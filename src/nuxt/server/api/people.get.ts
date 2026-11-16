import { getDb } from '../utils/db'
import type { CvEntry, Person } from '#shared/types/people'

export default defineEventHandler(async () => {
  const sql = getDb()

  const rows = await sql<Person[]>`
    select
      p.id,
      p.external_id,
      p.full_name,
      p.title,
      p.seniority,
      o.name as organization,
      o.kind as organization_kind,
      p.location,
      p.location_confidence,
      p.data_confidence,
      p.email,
      p.phone,
      p.contact_published,
      p.contact_state,
      p.do_not_contact,
      p.retention_until,
      p.it_experience_years,
      p.it_experience_basis,
      p.available_from,
      p.spoken_languages,
      fn_documented_experience(p.id)::int as documented_months,
      (select count(*) from person_employment e where e.person_id = p.id)::int as employment_count,
      coalesce(
        (select array_agg(c.tag order by c.tag)
           from person_competence pc join competence c on c.id = pc.competence_id
          where pc.person_id = p.id),
        '{}'::text[]
      ) as competences,
      (select count(*) from person_source ps where ps.person_id = p.id)::int as source_count,
      coalesce(
        (select array_agg(s.url) from person_source ps join source s on s.id = ps.source_id
          where ps.person_id = p.id),
        '{}'::text[]
      ) as source_urls,
      p.linkedin_slug,
      coalesce(
        (select array_agg(distinct cp.stage::text)
           from candidate_pipeline cp where cp.person_id = p.id),
        '{}'::text[]
      ) as pipeline_stages,
      coalesce(
        (select array_agg(distinct cp.role_label)
           from candidate_pipeline cp where cp.person_id = p.id),
        '{}'::text[]
      ) as pipeline_roles
    from person p
    left join organization o on o.id = p.organization_id
    order by o.name nulls last, p.full_name
  `

  // Anställningshistorik i CV-format: var, vad, hur länge.
  const cvRows = await sql<CvEntry[]>`
    select
      person_id,
      ref,
      title,
      organization,
      organization_kind,
      valid_from,
      valid_to,
      is_current,
      employment_type,
      confidence,
      stack,
      note,
      months,
      source_url,
      competences
    from v_cv
    order by person_id, is_current desc, valid_from desc nulls last
  `

  const cvByPerson = new Map<string, CvEntry[]>()
  for (const row of cvRows) {
    const list = cvByPerson.get(row.person_id) ?? []
    list.push(row)
    cvByPerson.set(row.person_id, list)
  }
  for (const person of rows) {
    person.cv = cvByPerson.get(person.id) ?? []
  }

  // Kompetenser grupperade efter kategori - 107 taggar blir annars oläsligt.
  const competenceRows = await sql<{ tag: string; category: string | null }[]>`
    select c.tag, c.category
    from competence c
    where exists (select 1 from person_competence pc where pc.competence_id = c.id)
    order by c.category nulls last, c.tag
  `
  const competenceGroups: Record<string, string[]> = {}
  for (const row of competenceRows) {
    const key = row.category || 'övrigt'
    ;(competenceGroups[key] ??= []).push(row.tag)
  }

  const organizations = [...new Set(rows.map(r => r.organization).filter(Boolean))].sort()
  const competences = [...new Set(rows.flatMap(r => r.competences))].sort()
  const locations = [...new Set(rows.map(r => r.location).filter(Boolean))].sort()
  const seniorities = [...new Set(rows.map(r => r.seniority).filter(Boolean))].sort()
  const spokenLanguages = [
    ...new Set(rows.flatMap(r => r.spoken_languages ?? [])),
  ].sort()

  return {
    people: rows,
    facets: {
      organizations,
      competences,
      locations,
      seniorities,
      spokenLanguages,
      competenceGroups,
    },
    count: rows.length,
  }
})
