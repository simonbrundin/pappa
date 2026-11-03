import { getDb } from '../utils/db'

/**
 * Kompetenstaxonomin - alla taggar med kategori.
 *
 * Används för att fylla kravformuläret: en must-have måste vara en riktig
 * tagg, annars matchar den ingenting.
 */
export default defineEventHandler(async () => {
  const sql = getDb()

  const rows = await sql<{ tag: string; category: string }[]>`
    select tag, coalesce(category, 'övrigt') as category
    from competence
    order by category, tag
  `

  const groups: Record<string, string[]> = {}
  for (const row of rows) {
    ;(groups[row.category] ??= []).push(row.tag)
  }

  return { tags: rows.map(r => r.tag), groups }
})
