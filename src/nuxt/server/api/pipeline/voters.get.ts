import { getDb } from '../../utils/db'
import type { PipelineVoter } from '#shared/types/pipeline'

/**
 * Listan över rörare - anställda och grundare. Används för att veta vem som
 * kan rösta i granskningssteget.
 */
export default defineEventHandler(async (): Promise<PipelineVoter[]> => {
  const sql = getDb()
  return await sql<PipelineVoter[]>`
    select id, name, role, active
      from pipeline_voter
     order by role, name
  `
})
