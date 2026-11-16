import { getDb } from '../utils/db'
import { isMissingSchema, throwMissingSchema } from '../utils/schema'
import type {
  PipelineCard,
  PipelineResponse,
  PipelineStage,
  PipelineVote,
  PipelineVoter,
} from '#shared/types/pipeline'

interface CardRow {
  id: string
  person_id: string
  full_name: string
  organization: string | null
  title: string | null
  location: string | null
  email: string | null
  phone: string | null
  do_not_contact: boolean
  linkedin_slug: string | null
  role_label: string
  stage: PipelineStage
  source: PipelineCard['source']
  source_note: string | null
  note: string | null
  drop_reason: string | null
  teams_ref: string | null
  owner_id: string | null
  owner_name: string | null
  owner_role: PipelineVoter['role'] | null
  entered_stage_at: string
  updated_at: string
}

interface VoteRow {
  pipeline_id: string
  voter_role: PipelineVoter['role']
  approved: boolean
  note: string | null
  at: string
  voter_name: string
}

/**
 * Boarden: alla pipeline-kort med röster, rörare och antal per steg.
 *
 * Läsning kräver ingen token - korten innehåller inga hemligheter, och
 * sidan ska kunna visas utan att man loggar in.
 */
export default defineEventHandler(async (): Promise<PipelineResponse> => {
  const sql = getDb()

  let rows: CardRow[]
  try {
    rows = await sql<CardRow[]>`
      select id, person_id, full_name, organization, title, location, email, phone,
             do_not_contact, linkedin_slug, role_label, stage, source, source_note,
             note, drop_reason, teams_ref, owner_id, owner_name, owner_role,
             entered_stage_at, updated_at
        from v_pipeline_board
       order by full_name, role_label
    `
  } catch (err) {
    // Saknas tabellerna ger ett begripligt svar i stället för ett rått 500.
    if (isMissingSchema(err)) throwMissingSchema()
    throw err
  }

  const voteRows = await sql<VoteRow[]>`
    select pipeline_id, voter_role, approved, note, at, voter_name
      from v_pipeline_votes
  `

  const votesByPipeline = new Map<string, PipelineVote[]>()
  for (const vote of voteRows) {
    const list = votesByPipeline.get(vote.pipeline_id) ?? []
    list.push({
      voter_role: vote.voter_role,
      voter_name: vote.voter_name,
      approved: vote.approved,
      note: vote.note,
      at: vote.at,
    })
    votesByPipeline.set(vote.pipeline_id, list)
  }

  const cards: PipelineCard[] = rows.map(row => {
    const votes: PipelineCard['votes'] = {}
    for (const vote of votesByPipeline.get(row.id) ?? []) {
      votes[vote.voter_role] = vote
    }
    return { ...row, votes }
  })

  const voters = await sql<PipelineVoter[]>`
    select id, name, role, active
      from pipeline_voter
     order by role, name
  `

  const counts: Record<string, number> = {}
  for (const card of cards) {
    if (card.stage === 'dropped') continue
    counts[card.stage] = (counts[card.stage] ?? 0) + 1
  }

  return {
    cards,
    voters,
    counts,
    droppedCount: cards.filter(c => c.stage === 'dropped').length,
  }
})
