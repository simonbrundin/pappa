/**
 * Typer för rekryteringspipen (kanban).
 *
 * Flödet: sourced -> teams_check -> review -> contacted -> lunch -> paper -> hired
 * `dropped` = bortfall, alltid med orsak.
 */

export type PipelineStage =
  | 'sourced'
  | 'teams_check'
  | 'review'
  | 'contacted'
  | 'lunch'
  | 'paper'
  | 'hired'
  | 'dropped'

export type PipelineVoterRole = 'employee' | 'founder'

/** Sökvägar - var kandidaten hittades. */
export type PipelineSource =
  | 'linkedin'
  | 'arbetsforrmedlingen'
  | 'boolag'
  | 'myndighet'
  | 'it_bolag_sundsvall'
  | 'soulmate_kontakt'
  | 'annat'

export interface PipelineVoter {
  id: string
  name: string
  role: PipelineVoterRole
  active: boolean
}

/** En röst på granskningskortet. */
export interface PipelineVote {
  voter_role: PipelineVoterRole
  voter_name: string
  approved: boolean
  note: string | null
  at: string
}

/** Ett kort på boarden. */
export interface PipelineCard {
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
  source: PipelineSource
  source_note: string | null
  note: string | null
  drop_reason: string | null
  /** Id på Planner-kortet, om kandidaten finns i Teams-listan. */
  teams_ref: string | null
  owner_id: string | null
  owner_name: string | null
  owner_role: PipelineVoterRole | null
  entered_stage_at: string
  updated_at: string
  votes: Partial<Record<PipelineVoterRole, PipelineVote>>
}

export interface PipelineResponse {
  cards: PipelineCard[]
  voters: PipelineVoter[]
  /** Antal per steg (utan bortfall). */
  counts: Record<string, number>
  droppedCount: number
}

/** Ett kort ur Teams/Planner-listan "Rekrytering". */
export interface PlannerCard {
  id: string
  external_id: string
  title: string
  bucket: string | null
  description: string | null
  person_id: string | null
  person_name: string | null
  match_score: number | null
  /** exact | name+org | name_only | manual | null */
  match_kind: string | null
  imported_at: string
}

export interface PlannerResponse {
  cards: PlannerCard[]
  matched: number
  unmatched: number
}

/** Kolumnerna i boarden, i ordning. */
export const PIPELINE_STAGES: { stage: PipelineStage; label: string; icon: string }[] = [
  { stage: 'sourced', label: 'Sökt', icon: '🔍' },
  { stage: 'teams_check', label: 'Teams-koll', icon: '🪪' },
  { stage: 'review', label: 'Granskning', icon: '👍' },
  { stage: 'contacted', label: 'Kontaktad', icon: '✉️' },
  { stage: 'lunch', label: 'Lunch', icon: '🍽️' },
  { stage: 'paper', label: 'Kritat papper', icon: '🥂' },
  { stage: 'hired', label: 'Anställd', icon: '✅' },
]

export const PIPELINE_SOURCE_LABELS: Record<PipelineSource, string> = {
  linkedin: 'LinkedIn',
  arbetsforrmedlingen: 'Arbetsförmedlingen',
  boolag: 'Boolag.se',
  myndighet: 'Myndigheterna',
  it_bolag_sundsvall: 'IT-bolag i Sundsvall',
  soulmate_kontakt: 'Soulmate-kontakt',
  annat: 'Annat',
}
