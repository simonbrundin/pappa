<script setup lang="ts">
import type { JobProfile, MatchCandidate, ProfilesResponse } from '#shared/types/people'

/**
 * Uppdragsvyn: kravprofil -> rankade kandidater.
 *
 * Poängen är alltid delpoäng + förklaring. Förklaringen ska läsas innan
 * någon kontaktas - en hög poäng kan bygga på en gissad erfarenhet.
 */

const { data: profileData, refresh: refreshProfiles } = await useFetch<ProfilesResponse>(
  '/api/profiles',
  { key: 'job-profiles', default: (): ProfilesResponse => ({ profiles: [] }) },
)

const { data: competenceData } = await useFetch<{ tags: string[] }>('/api/competences', {
  key: 'competence-tags',
  default: (): { tags: string[] } => ({ tags: [] }),
})

/** Vald profil och redigeringsformulär. */
const selectedId = ref<string | null>(null)
const form = reactive({
  id: '' as string | null,
  title: '',
  client_name: '',
  notes: '',
  must_have: [] as string[],
  min_must_have: null as number | null,
  nice_to_have: [] as string[],
  min_seniority: '' as string,
  min_experience_years: null as number | null,
  required_location: '',
  accepted_locations: [] as string[],
  required_languages: [] as string[],
  weights: {
    must_have: 40,
    nice_to_have: 10,
    experience: 15,
    seniority: 10,
    location: 10,
    language: 5,
    availability: 5,
    confidence: 5,
  } as Record<string, number>,
})

const matches = ref<{ profile: JobProfile; candidates: MatchCandidate[]; eligibleCount: number } | null>(null)

/**
 * Otypad $fetch. Nuxts typade varianter ger "excessive stack depth" när
 * antalet routes växer - här är svaret bara ett eget API-svar.
 */
const api = $fetch as unknown as (
  url: string,
  options?: Record<string, unknown>,
) => Promise<unknown>
const matchesStatus = ref<'idle' | 'pending' | 'error'>('idle')
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null)
const saving = ref(false)
const expanded = ref<string | null>(null)
const onlyEligible = ref(true)
const showRejected = ref(false)

const profiles = computed(() => profileData.value?.profiles ?? [])
const tagSuggestions = computed(() => competenceData.value?.tags ?? [])

const candidates = computed(() => matches.value?.candidates ?? [])
const eligible = computed(() => candidates.value.filter(c => c.eligible))
const rejected = computed(() => candidates.value.filter(c => !c.eligible))

const WEIGHT_LABELS: Record<string, string> = {
  must_have: 'Must-have',
  nice_to_have: 'Nice-to-have',
  experience: 'Erfarenhet',
  seniority: 'Senioritet',
  location: 'Ort',
  language: 'Språk',
  availability: 'Tillgänglighet',
  confidence: 'Datakonfidens',
}

const SENIORITY_OPTIONS = [
  { value: '', label: '— inget krav —' },
  { value: 'junior', label: 'junior' },
  { value: 'mid', label: 'mid' },
  { value: 'senior', label: 'senior' },
  { value: 'lead', label: 'lead' },
  { value: 'chef', label: 'chef' },
  { value: 'cxo', label: 'cxo' },
]

// Välj första profilen redan under setup - då renderas listan direkt,
// även vid server-side rendering.
if (profiles.value.length) {
  fillForm(profiles.value[0]!)
  await loadMatches(profiles.value[0]!.id)
}

onMounted(() => {
  // Klienten kan ha en tom lista vid första renderingen.
  if (!selectedId.value && profiles.value.length) {
    edit(profiles.value[0]!)
  }
})

/** Fyll formuläret från en profil. */
function fillForm(profile: JobProfile) {
  selectedId.value = profile.id
  form.id = profile.id
  form.title = profile.title
  form.client_name = profile.client_name ?? ''
  form.notes = profile.notes ?? ''
  form.must_have = [...profile.must_have]
  form.min_must_have = profile.min_must_have
  form.nice_to_have = [...profile.nice_to_have]
  form.min_seniority = profile.min_seniority ?? ''
  form.min_experience_years = profile.min_experience_years
  form.required_location = profile.required_location ?? ''
  form.accepted_locations = [...profile.accepted_locations]
  form.required_languages = [...profile.required_languages]
  form.weights = {
    must_have: 40,
    nice_to_have: 10,
    experience: 15,
    seniority: 10,
    location: 10,
    language: 5,
    availability: 5,
    confidence: 5,
    ...profile.weights,
  }
  message.value = null
}

/** Välj en profil och ladda dess matchning. */
function edit(profile: JobProfile) {
  fillForm(profile)
  loadMatches(profile.id)
}

function newProfile() {
  selectedId.value = null
  form.id = null
  form.title = ''
  form.client_name = ''
  form.notes = ''
  form.must_have = []
  form.min_must_have = null
  form.nice_to_have = []
  form.min_seniority = ''
  form.min_experience_years = null
  form.required_location = 'Sundsvall'
  form.accepted_locations = []
  form.required_languages = []
  form.weights = {
    must_have: 40,
    nice_to_have: 10,
    experience: 15,
    seniority: 10,
    location: 10,
    language: 5,
    availability: 5,
    confidence: 5,
  }
  matches.value = null
  message.value = null
}

async function loadMatches(profileId: string) {
  matchesStatus.value = 'pending'
  try {
    matches.value = (await api('/api/matches', {
      query: { profile: profileId },
    })) as typeof matches.value
    matchesStatus.value = 'idle'
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    message.value = { tone: 'error', text: e.data?.message ?? 'Kunde inte hämta matchningen.' }
    matchesStatus.value = 'error'
  }
}

async function saveProfile() {
  if (!form.title.trim()) {
    message.value = { tone: 'error', text: 'Profilen behöver en titel.' }
    return
  }
  saving.value = true
  message.value = null
  try {
    const result = (await api('/api/profiles', {
      method: 'POST',
      body: {
        id: form.id,
        title: form.title,
        client_name: form.client_name || null,
        notes: form.notes || null,
        must_have: form.must_have,
        min_must_have: form.min_must_have,
        nice_to_have: form.nice_to_have,
        min_seniority: form.min_seniority || null,
        min_experience_years: form.min_experience_years,
        required_location: form.required_location || null,
        accepted_locations: form.accepted_locations,
        required_languages: form.required_languages,
        weights: form.weights,
      },
    })) as { id: string }
    form.id = result.id
    selectedId.value = result.id
    message.value = { tone: 'ok', text: 'Profilen är sparad.' }
    await refreshProfiles()
    await loadMatches(result.id)
  } catch (err: unknown) {
    const e = err as {
      data?: { message?: string; statusCode?: number }
      statusMessage?: string
      statusCode?: number
    }
    const base = e.data?.message ?? e.statusMessage ?? 'Kunde inte spara profilen.'
    const status = e.statusCode ?? e.data?.statusCode
    message.value = {
      tone: 'error',
      text:
        status === 401
          ? `${base} Logga in på /admin.`
          : base,
    }
  } finally {
    saving.value = false
  }
}

/** Etikett för erfarenhetsgrunden. */
function basisLabel(basis: string): string {
  switch (basis) {
    case 'documented':
      return 'dokumenterad'
    case 'explicit':
      return 'angiven'
    case 'notes':
      return 'ur anteckningar'
    case 'seniority':
      return 'uppskattad (rollnivå)'
    default:
      return 'okänd'
  }
}

useHead({
  title: 'Pappa – Uppdrag och rankning',
  meta: [{ name: 'description', content: 'Rangordna kandidater mot en kravprofil.' }],
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-5 py-10 sm:px-8">
    <header class="mb-8 flex flex-wrap items-center gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-white">Uppdrag</h1>
        <p class="text-sm text-ink-400">
          Kravprofil → rankade kandidater. Poängen är delpoäng – läs förklaringen.
        </p>
      </div>
    </header>

    <div class="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <!-- Vänster: profiler -->
      <aside class="space-y-4">
        <section class="card p-4">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-white">Kravprofiler</h2>
            <button
              type="button"
              class="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
              @click="newProfile"
            >
              + Ny
            </button>
          </div>

          <ul v-if="profiles.length" class="space-y-1.5">
            <li v-for="profile in profiles" :key="profile.id">
              <button
                type="button"
                class="w-full rounded-lg border px-3 py-2 text-left text-sm transition"
                :class="selectedId === profile.id
                  ? 'border-brand-500/50 bg-brand-500/10 text-white'
                  : 'border-white/8 text-ink-300 hover:border-white/20 hover:text-white'"
                @click="edit(profile)"
              >
                <span class="block truncate">{{ profile.title }}</span>
                <span v-if="profile.client_name" class="block truncate text-xs text-ink-400">
                  {{ profile.client_name }}
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="text-xs text-ink-400">Inga profiler ännu.</p>
        </section>
      </aside>

      <!-- Höger: formulär + rankad lista -->
      <div class="space-y-6">
        <section class="card p-5">
          <div class="mb-4 flex flex-wrap items-center gap-3">
            <h2 class="text-lg font-semibold text-white">
              {{ form.id ? 'Redigera kravprofil' : 'Ny kravprofil' }}
            </h2>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">Titel</span>
              <input
                v-model="form.title"
                type="text"
                placeholder="T.ex. Senior systemutvecklare"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">Kund</span>
              <input
                v-model="form.client_name"
                type="text"
                placeholder="Kundens namn"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
              />
            </label>
          </div>

          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">
                Must-have
              </span>
              <TagInput v-model="form.must_have" :suggestions="tagSuggestions" />
              <p class="mt-1.5 text-xs text-ink-400">
                Taggar som krävs. Normalt EN tagg – flera taggar gör kravet för snävt.
              </p>
            </div>
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">
                Minst antal must-have
              </span>
              <input
                v-model.number="form.min_must_have"
                type="number"
                min="1"
                :max="Math.max(form.must_have.length, 1)"
                :placeholder="`alla (${form.must_have.length})`"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
              />
              <p class="mt-1.5 text-xs text-ink-400">
                Tomt = alla must-have måste täckas. Sätt t.ex. 2 för "minst 2 av 3".
              </p>
            </div>
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">
                Nice-to-have
              </span>
              <TagInput v-model="form.nice_to_have" :suggestions="tagSuggestions" />
            </div>
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">Ort</span>
              <input
                v-model="form.required_location"
                type="text"
                placeholder="Sundsvall"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
              />
              <span class="mb-1 mt-3 block text-xs uppercase tracking-wide text-ink-400">
                Pendelorter
              </span>
              <TagInput v-model="form.accepted_locations" placeholder="Örnsköldsvik" />
            </div>
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">
                Minsta senioritet
              </span>
              <select
                v-model="form.min_seniority"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
              >
                <option v-for="option in SENIORITY_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <span class="mb-1 mt-3 block text-xs uppercase tracking-wide text-ink-400">
                Minsta år i IT
              </span>
              <input
                v-model.number="form.min_experience_years"
                type="number"
                min="0"
                placeholder="t.ex. 8"
                class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">Språk</span>
              <TagInput v-model="form.required_languages" placeholder="svenska" />
              <p class="mt-1.5 text-xs text-ink-400">
                Ingen språkdata finns ännu – delen blir neutral (50) tills dess.
              </p>
            </div>
          </div>

          <details class="mt-4 rounded-xl border border-white/8 px-3 py-2">
            <summary class="cursor-pointer text-xs text-ink-300">Vikter per del</summary>
            <div class="mt-3 grid gap-3 sm:grid-cols-4">
              <label v-for="(label, key) in WEIGHT_LABELS" :key="key" class="block">
                <span class="mb-1 block text-[11px] uppercase tracking-wide text-ink-400">
                  {{ label }}
                </span>
                <input
                  v-model.number="form.weights[key]"
                  type="number"
                  min="0"
                  class="w-full rounded-lg border border-white/10 bg-ink-950/60 px-2 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
                />
              </label>
            </div>
            <p class="mt-2 text-xs text-ink-400">
              Vikterna styr hur delpoängen vägs samman. Delar som profilen inte styr
              (t.ex. språk utan krav) räknas inte in.
            </p>
          </details>

          <p
            v-if="message"
            class="mt-4 rounded-xl px-4 py-3 text-xs"
            :class="message.tone === 'ok'
              ? 'border border-mint-400/30 bg-mint-400/10 text-mint-400'
              : 'border border-rose-soft/30 bg-rose-soft/10 text-rose-soft'"
          >
            {{ message.text }}
          </p>

          <button
            type="button"
            class="mt-4 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-ink-950 transition hover:bg-brand-400 disabled:opacity-40"
            :disabled="saving"
            @click="saveProfile"
          >
            {{ saving ? 'Sparar…' : 'Spara profil' }}
          </button>
        </section>

        <section v-if="matches" class="card p-5">
          <header class="mb-4 flex flex-wrap items-center gap-3">
            <h2 class="text-lg font-semibold text-white">Rankade kandidater</h2>
            <span class="chip">{{ eligible.length }} godkända</span>
            <span v-if="rejected.length" class="chip">{{ rejected.length }} underkända</span>
            <label class="ml-auto flex items-center gap-2 text-xs text-ink-300">
              <input v-model="onlyEligible" type="checkbox" class="accent-brand-500" />
              Endast godkända
            </label>
          </header>

          <p class="mb-4 rounded-xl border border-amber-soft/25 bg-amber-soft/10 px-4 py-3 text-xs leading-relaxed text-ink-100">
            En kandidat måste täcka must-have-kravet. Erfarenhet som bygger på rollnivå
            är en gissning – den står i förklaringen och ska läsas.
          </p>

          <ul class="space-y-2">
            <li
              v-for="(candidate, index) in onlyEligible ? eligible : candidates"
              :key="candidate.person_id"
              class="rounded-xl border border-white/8 bg-ink-950/40"
            >
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
                @click="expanded = expanded === candidate.person_id ? null : candidate.person_id"
              >
                <span class="w-6 text-xs text-ink-400">{{ index + 1 }}.</span>
                <span class="min-w-48 flex-1">
                  <span class="block text-sm text-white">{{ candidate.full_name }}</span>
                  <span class="block text-xs text-ink-400">
                    {{ candidate.title ?? '—' }}
                    <template v-if="candidate.organization"> · {{ candidate.organization }}</template>
                  </span>
                </span>
                <span class="chip text-xs">
                  {{ candidate.must_covered }}/{{ candidate.must_total }} must
                </span>
                <span class="chip text-xs">
                  {{ candidate.nice_covered }}/{{ candidate.nice_total }} nice
                </span>
                <span
                  class="text-xs"
                  :class="candidate.experience_basis === 'documented'
                    ? 'text-mint-400'
                    : candidate.experience_basis === 'seniority'
                      ? 'text-amber-soft'
                      : 'text-ink-300'"
                >
                  {{ candidate.experience_years ?? '?' }} år ({{ basisLabel(candidate.experience_basis) }})
                </span>
                <span class="w-14 text-right text-lg font-semibold text-white">
                  {{ candidate.score ?? '—' }}
                </span>
              </button>

              <div
                v-if="expanded === candidate.person_id"
                class="border-t border-white/8 px-4 py-3"
              >
                <ul class="space-y-1 text-xs text-ink-300">
                  <li v-for="(line, i) in candidate.explanation" :key="i">– {{ line }}</li>
                </ul>

                <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div v-for="part in [
                    { key: 'must_score', label: 'Must-have' },
                    { key: 'nice_score', label: 'Nice-to-have' },
                    { key: 'experience_score', label: 'Erfarenhet' },
                    { key: 'seniority_score', label: 'Senioritet' },
                    { key: 'location_score', label: 'Ort' },
                    { key: 'language_score', label: 'Språk' },
                    { key: 'availability_score', label: 'Tillgänglighet' },
                    { key: 'confidence_score', label: 'Datakonfidens' },
                  ]" :key="part.key" class="flex justify-between gap-2">
                    <dt class="text-ink-400">{{ part.label }}</dt>
                    <dd class="text-ink-100">{{ candidate[part.key as keyof typeof candidate] ?? '—' }}</dd>
                  </div>
                </dl>

                <p v-if="candidate.must_missing.length" class="mt-3 text-xs text-rose-soft">
                  Saknar must-have: {{ candidate.must_missing.join(', ') }}
                </p>
              </div>
            </li>
          </ul>

          <div v-if="showRejected && rejected.length" class="mt-6 border-t border-white/8 pt-4">
            <button
              type="button"
              class="text-xs text-ink-400 transition hover:text-white"
              @click="showRejected = !showRejected"
            >
              {{ showRejected ? '▾' : '▸' }} {{ rejected.length }} underkända (täcker inte must-have)
            </button>
            <ul v-if="showRejected" class="mt-3 space-y-1">
              <li
                v-for="candidate in rejected"
                :key="candidate.person_id"
                class="rounded-lg border border-white/8 bg-ink-950/30 px-3 py-2 text-xs text-ink-300"
              >
                <span class="text-white">{{ candidate.full_name }}</span>
                · {{ candidate.must_covered }}/{{ candidate.must_total }} must
                <span v-if="candidate.must_missing.length" class="text-rose-soft">
                  – saknar {{ candidate.must_missing.join(', ') }}
                </span>
                <span class="float-right">{{ candidate.score }}</span>
              </li>
            </ul>
          </div>
          <button
            v-else-if="rejected.length"
            type="button"
            class="mt-6 text-xs text-ink-400 transition hover:text-white"
            @click="showRejected = true"
          >
            ▸ {{ rejected.length }} underkända (täcker inte must-have)
          </button>
        </section>

        <p v-else-if="matchesStatus === 'pending'" class="text-sm text-ink-400">
          Räknar matchningen…
        </p>
      </div>
    </div>
  </div>
</template>
