import { getDb } from '../../utils/db'
import { requireAdmin } from '../../utils/requireAdmin'

interface VoterBody {
  name?: string
  role?: 'employee' | 'founder'
  id?: string
  op?: 'add' | 'deactivate' | 'activate'
}

/**
 * Lägg till rörare. Namnlistan ersätter inloggning tills vidare - röstaren
 * väljer sitt namn i granskningssteget, och beslutet lagras med namnet.
 */
export default defineEventHandler(async event => {
  requireAdmin(event)

  const body = await readBody<VoterBody>(event)
  const sql = getDb()

  if (body.op === 'deactivate' || body.op === 'activate') {
    if (!body.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Felaktig begäran',
        message: 'Röraren saknas.',
      })
    }
    await sql`
      update pipeline_voter set active = ${body.op === 'activate'} where id = ${body.id}::uuid
    `
    return { ok: true }
  }

  const name = body.name?.trim()
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Felaktig begäran',
      message: 'Namnet saknas.',
    })
  }

  const role = body.role === 'founder' ? 'founder' : 'employee'

  const [voter] = await sql<{ id: string }[]>`
    insert into pipeline_voter (name, role)
    values (${name}, ${role}::pipeline_voter_role)
    on conflict (name) do update
       set role = excluded.role, active = true
    returning id
  `

  if (!voter) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Kunde inte spara',
      message: 'Röraren kunde inte sparas.',
    })
  }

  return { ok: true, id: voter.id }
})
