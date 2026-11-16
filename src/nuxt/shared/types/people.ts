export interface Person {
  id: string
  external_id: string
  full_name: string
  title: string | null
  seniority: string | null
  organization: string | null
  organization_kind: string | null
  location: string | null
  location_confidence: string | null
  data_confidence: string | null
  email: string | null
  phone: string | null
  contact_published: boolean
  contact_state: string | null
  do_not_contact: boolean
  retention_until: string | null
  /** Minsta antal år personen varit i IT. null = okänt. */
  it_experience_years: number | null
  /** Grund för it_experience_years: explicit | documented | notes | seniority | null. */
  it_experience_basis: 'explicit' | 'documented' | 'notes' | 'seniority' | null
  /** När personen kan börja på nytt uppdrag. null = okänt. */
  available_from: string | null
  /** Talade språk. Tom = okänt. */
  spoken_languages: string[]
  /** Dokumenterad erfarenhet i månader, beräknad ur anställningshistoriken. */
  documented_months: number
  /** Antal anställningsrader (CV-poster). */
  employment_count: number
  competences: string[]
  source_count: number
  source_urls: string[]
  linkedin_slug: string | null
  /** Indikerar om kandidaten är i den aktiva rekryteringspoolen. */
  is_potential: boolean
  /** Skäl till varför kandidaten inte är aktuell. */
  not_relevant_reason: string | null
  /** Datum för nästa genomgång. */
  potential_review_at: string | null
  /** Pipeline-steg personen är aktuell för (tom = inte i pipen). */
  pipeline_stages: string[]
  /** Roller personen är aktuell för i pipen. */
  pipeline_roles: string[]
  /** Anställningshistorik: var, vad, hur länge. */
  cv: CvEntry[]
}

/** En rad i CV:t - en anställning. */
export interface CvEntry {
  person_id: string
  ref: string | null
  title: string | null
  organization: string | null
  organization_kind: string | null
  valid_from: string | null
  valid_to: string | null
  is_current: boolean
  employment_type: string | null
  confidence: 'high' | 'medium' | 'low' | null
  stack: string[]
  note: string | null
  /** Längd i månader. null = perioden är inte daterad. */
  months: number | null
  source_url: string | null
  competences: string[] | null
}

export interface PeopleFacets {
  organizations: string[]
  competences: string[]
  locations: string[]
  seniorities: string[]
  spokenLanguages: string[]
  /** Kompetenser grupperade efter kategori. */
  competenceGroups: Record<string, string[]>
}

export interface PeopleResponse {
  people: Person[]
  facets: PeopleFacets
  count: number
}

/** En sida i ett dubblettpar. */
export interface DuplicateSide {
  id: string
  name: string
  organization: string | null
  title: string | null
  email: string | null
  phone: string | null
  employments: number
  sources: number
}

/**
 * Ett par som bör granskas. Är ett FÖRSLAG - aldrig ett svar.
 * Signaler: 'samma e-post', 'samma telefon', 'samma namn',
 * 'samma namn, utökad form', 'samma namn, 1-3 tecken fel',
 * 'gemensamt förnamn', 'gemensamt efternamn', 'liknande förnamn',
 * 'liknande efternamn'.
 */
export interface DuplicateCandidate {
  id_a: string
  id_b: string
  name_a: string
  name_b: string
  org_a: string | null
  org_b: string | null
  title_a: string | null
  title_b: string | null
  email_a: string | null
  email_b: string | null
  phone_a: string | null
  phone_b: string | null
  similarity: number
  same_org: boolean
  same_email: boolean
  same_phone: boolean
  shared_competences: number
  signal: string
  score: number
  /** Hur förnamnen matchar: exact | prefix | near | none. */
  given_kind: string
  /** Hur efternamnen matchar: exact | prefix | near | none. */
  family_kind: string
  /** true = bara en namndel stämmer - nästan alltid olika personer. */
  weak: boolean
  a: DuplicateSide
  b: DuplicateSide
}

export interface DuplicatesResponse {
  /** Starka kandidater - kan slås ihop. */
  candidates: DuplicateCandidate[]
  /** Svagare par - bara ett gemensamt förnamn/efternamn. */
  weak: DuplicateCandidate[]
  count: number
  weakCount: number
}

/** Kravprofil för ett uppdrag. Vikterna styr hur delpoängen vägs samman. */
export interface JobProfile {
  id: string
  slug: string | null
  title: string
  client_name: string | null
  notes: string | null
  must_have: string[]
  /** Hur många must-have som minst krävs. Null = alla. */
  min_must_have: number | null
  nice_to_have: string[]
  min_seniority: string | null
  min_experience_years: number | null
  required_location: string | null
  accepted_locations: string[]
  required_languages: string[]
  available_by: string | null
  weights: Record<string, number>
}

export interface ProfilesResponse {
  profiles: JobProfile[]
}

/**
 * En rangordnad kandidat. Poängen är alltid delpoäng + förklaring -
 * beslutet ska kunna motiveras och ifrågasättas.
 */
export interface MatchCandidate {
  person_id: string
  full_name: string
  title: string | null
  organization: string | null
  /** Viktad poäng 0-100. */
  score: number | null
  /** False om kandidaten inte täcker must-have-kravet. */
  eligible: boolean
  must_score: number | null
  nice_score: number | null
  experience_score: number | null
  seniority_score: number | null
  location_score: number | null
  language_score: number | null
  availability_score: number | null
  confidence_score: number | null
  documented_months: number
  experience_years: number | null
  /** documented | explicit | notes | seniority | unknown */
  experience_basis: string
  seniority: string | null
  location: string | null
  must_covered: number
  must_total: number
  must_missing: string[]
  nice_covered: number
  nice_total: number
  explanation: string[]
}

export interface MatchesResponse {
  profile: JobProfile
  candidates: MatchCandidate[]
  eligibleCount: number
}
