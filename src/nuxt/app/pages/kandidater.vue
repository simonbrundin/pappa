<script setup lang="ts">
import { PIPELINE_SOURCE_LABELS } from '#shared/types/pipeline'
import type { PipelineSource } from '#shared/types/pipeline'
import type { Person } from '#shared/types/people'
import {
  NOT_RELEVANT_REASONS,
  defaultReviewDate,
  formatDate,
  splitByPotential,
} from '#shared/utils/potential'
import type { PotentialTab } from '#shared/utils/potential'

const { data, status, error, refresh } = usePeople()

const search = ref('')
const organization = ref('')
const location = ref('')
const seniority = ref('')
const competences = ref<string[]>([])
const sort = ref('name')
const minExperience = ref(0)
const onlyDocumented = ref(false)
/**
 * Visa panelen med dubblettkandidater.
 * Kan öppnas via ?duplicates=1 i URL:en - då går den att länka till.
 */
const route = useRoute()
const router = useRouter()
const showDuplicates = ref(route.query.duplicates === '1')
const showMoreFilters = ref(false)

// ---------------------------------------------------------------------------
// Flikar: potentiella kandidater och parkade (inte aktuella just nu)
//
// "Parkad" betyder att personen inte är aktuell NU - t.ex. en konsult som
// driver eget bolag. Då sparar vi ett datum för nästa genomgång: den dagen
// kommer personen automatiskt tillbaka i fliken "Potentiella", så att det
// går att försöka rekrytera henne igen.
// ---------------------------------------------------------------------------
const tab = ref<PotentialTab>(
  route.query.tab === 'ej-aktuella' ? 'ej-aktuella' : 'potentiella',
)

watch(tab, value => {
  router.replace({ query: { ...route.query, tab: value } })
})

// ---------------------------------------------------------------------------
// Lägg i pipeline
//
// Sourcingen (sökvägar + "solla") sker här: filtren väljer ur kandidaterna,
// och den som är relevant läggs in i pipen med roll och sökväg.
// ---------------------------------------------------------------------------
const addTarget = ref<Person | null>(null)
const addRole = ref('')
const addSource = ref<PipelineSource>('annat')
const addBusy = ref(false)
const addMessage = ref<string | null>(null)

function openAdd(person: Person) {
  addTarget.value = person
  addRole.value = ''
  addSource.value = 'annat'
  addMessage.value = null
}

async function submitAdd() {
  if (!addTarget.value) return
  addBusy.value = true
  addMessage.value = null
  try {
    await $fetch('/api/pipeline', {
      method: 'POST',
      body: {
        op: 'create',
        person_id: addTarget.value.id,
        role_label: addRole.value.trim() || 'Okänd roll',
        source: addSource.value,
      },
    })
    addTarget.value = null
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string }; statusMessage?: string }
    addMessage.value = e.data?.message ?? e.statusMessage ?? 'Kunde inte lägga in i pipen.'
  } finally {
    addBusy.value = false
  }
}

const people = computed(() => data.value?.people ?? [])

// ---------------------------------------------------------------------------
// Parka en kandidat (inte aktuell nu)
//
// En kandidat som inte är aktuell nu - t.ex. en som driver eget
// konsultbolag - kan bli aktuell igen. Därför sparar vi skälet och ett
// datum för nästa genomgång tillsammans med parkeringen.
// ---------------------------------------------------------------------------
const parkTarget = ref<Person | null>(null)
const parkReason = ref<string>(NOT_RELEVANT_REASONS[0])
const parkNote = ref('')
const parkDate = ref(defaultReviewDate())
const potentialBusy = ref(false)
const potentialMessage = ref<{ tone: 'ok' | 'error'; text: string } | null>(null)

/**
 * Skrivning kräver adminsession (lösenordet sätts i /admin).
 * Kandidater kan läsas utan inloggning - bara parkering kräver session.
 */
const { authenticated: adminAuth, refresh: refreshAdmin } = useAdminSession()
onMounted(() => {
  refreshAdmin()
})

function openPark(person: Person) {
  parkTarget.value = person
  parkReason.value = NOT_RELEVANT_REASONS[0]
  parkNote.value = ''
  parkDate.value = defaultReviewDate()
  potentialMessage.value = null
  refreshAdmin()
}

function closePark() {
  if (potentialBusy.value) return
  parkTarget.value = null
}

/** Skrivningen kräver adminsession - logga in på /admin. */
function potentialError(err: unknown): string {
  const e = err as { data?: { message?: string; statusCode?: number }; statusMessage?: string; statusCode?: number }
  const base = e.data?.message ?? e.statusMessage ?? 'Kunde inte uppdatera kandidaten.'
  const status = e.statusCode ?? e.data?.statusCode
  return status === 401 ? `${base} Logga in på /admin.` : base
}

async function submitPark() {
  if (!parkTarget.value) return
  potentialBusy.value = true
  potentialMessage.value = null
  const name = parkTarget.value.full_name
  const date = parkDate.value
  try {
    await $fetch('/api/potential', {
      method: 'PATCH',
      body: {
        person_id: parkTarget.value.id,
        is_potential: false,
        not_relevant_reason: parkNote.value.trim() || parkReason.value,
        potential_review_at: date,
      },
    })
    parkTarget.value = null
    potentialMessage.value = {
      tone: 'ok',
      text: `${name} är inte aktuell just nu - ses över ${formatDate(date)}.`,
    }
    await refresh()
  } catch (err: unknown) {
    potentialMessage.value = { tone: 'error', text: potentialError(err) }
  } finally {
    potentialBusy.value = false
  }
}

/** Lägg tillbaka kandidaten i rekryteringspoolen. */
async function reactivate(person: Person) {
  potentialBusy.value = true
  potentialMessage.value = null
  try {
    await $fetch('/api/potential', {
      method: 'PATCH',
      body: { person_id: person.id, is_potential: true },
    })
    potentialMessage.value = { tone: 'ok', text: `${person.full_name} är aktuell igen.` }
    await refresh()
  } catch (err: unknown) {
    potentialMessage.value = { tone: 'error', text: potentialError(err) }
  } finally {
    potentialBusy.value = false
  }
}

/**
 * Personer med okänd erfarenhet räknas inte som "3+ år" - vi kan inte
 * visa att de klarar filtret. De redovisas i en egen rad under filtren.
 */
const unknownExperience = computed(() =>
  minExperience.value > 0
    ? people.value.filter(p => p.it_experience_years === null).length
    : 0,
)

const matching = computed(() => {
  const term = search.value.trim().toLowerCase()

  const matches = people.value.filter(person => {
    if (organization.value && person.organization !== organization.value) return false
    if (location.value && person.location !== location.value) return false
    if (seniority.value && person.seniority !== seniority.value) return false
    if (onlyDocumented.value && person.documented_months <= 0) return false
    if (
      minExperience.value > 0 &&
      (person.it_experience_years === null || person.it_experience_years < minExperience.value)
    ) {
      return false
    }
    if (competences.value.length && !competences.value.every(c => person.competences.includes(c))) {
      return false
    }
    if (!term) return true

    return [
      person.full_name,
      person.title,
      person.organization,
      person.location,
      ...person.competences,
      ...person.cv.map(c => `${c.organization ?? ''} ${c.title ?? ''}`),
    ]
      .filter(Boolean)
      .some(field => String(field).toLowerCase().includes(term))
  })

  const sorted = [...matches]
  switch (sort.value) {
    case 'org':
      sorted.sort((a, b) =>
        (a.organization ?? '').localeCompare(b.organization ?? '') ||
        a.full_name.localeCompare(b.full_name),
      )
      break
    case 'confidence': {
      const weight: Record<string, number> = { high: 3, medium: 2, low: 1 }
      sorted.sort(
        (a, b) => (weight[b.data_confidence ?? 'low'] ?? 0) - (weight[a.data_confidence ?? 'low'] ?? 0),
      )
      break
    }
    case 'documented':
      sorted.sort(
        (a, b) =>
          b.documented_months - a.documented_months || a.full_name.localeCompare(b.full_name),
      )
      break
    default:
      sorted.sort((a, b) => a.full_name.localeCompare(b.full_name))
  }
  return sorted
})

/** Antal aktuella respektive parkade kandidater. */
const currentCount = computed(() => people.value.filter(p => p.is_potential).length)
const parkedCount = computed(() => people.value.length - currentCount.value)

/**
 * Kandidaterna i den valda fliken.
 *
 * Fliken "Potentiella" visar rekryteringspoolen. Fliken "Ej aktuella" visar
 * personer som är parkerade - sorterade på när de ska ses över, så att
 * nästa genomgång ligger överst.
 */
const tabPeople = computed(() => {
  const { current, parked } = splitByPotential(matching.value)
  if (tab.value === 'potentiella') return current

  return [...parked].sort((a, b) => {
    const aDate = a.potential_review_at ?? '9999-12-31'
    const bDate = b.potential_review_at ?? '9999-12-31'
    return aDate.localeCompare(bDate) || a.full_name.localeCompare(b.full_name)
  })
})

const hasFilters = computed(
  () =>
    !!search.value ||
    !!organization.value ||
    !!location.value ||
    !!seniority.value ||
    minExperience.value > 0 ||
    onlyDocumented.value ||
    competences.value.length > 0,
)

function resetFilters() {
  search.value = ''
  organization.value = ''
  location.value = ''
  seniority.value = ''
  minExperience.value = 0
  onlyDocumented.value = false
  competences.value = []
}

function toggleCompetence(tag: string) {
  competences.value = competences.value.includes(tag)
    ? competences.value.filter(c => c !== tag)
    : [...competences.value, tag]
}

/** Snygga namn på kompetenskategorierna (kategorin "languages" = programspråk). */
const categoryLabels: Record<string, string> = {
  languages: 'Programspråk',
  frontend: 'Frontend',
  backend: 'Backend',
  data: 'Data & AI',
  cloud_platform: 'Cloud',
  devops: 'DevOps',
  security: 'Säkerhet',
  enterprise: 'Enterprise',
  delivery: 'Leverans',
  business: 'Affär',
  domain: 'Domän',
  meta: 'Nätverk & övrigt',
  övrigt: 'Övrigt',
}

useHead({
  title: 'Pappa – Kandidater',
  meta: [{ name: 'description', content: 'Alla kandidater ur masterdatabasen.' }],
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-5 py-10 sm:px-8">
    <header class="mb-10">
      <div class="flex flex-wrap items-center gap-3">
        <span
          class="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-mint-400 text-lg font-bold text-ink-950 shadow-lg shadow-brand-500/25"
        >
          P
        </span>
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            IT-rekrytering i Sundsvall
          </h1>
          <p class="text-sm text-ink-400">
            {{ data?.count ?? 0 }} kandidater i masterdatabasen
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
          @click="showDuplicates = !showDuplicates"
        >
          {{ showDuplicates ? '✕ Dölj dubbletter' : '⇄ Dubbletter' }}
        </button>
        <button
          type="button"
          class="ml-auto rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
          @click="refresh()"
        >
          ↻ Uppdatera
        </button>
      </div>
    </header>

    <!-- Flikar: potentiella kandidater vs. parkade (inte aktuella just nu) -->
    <nav class="mb-6 flex flex-wrap gap-1 rounded-xl border border-white/10 bg-ink-950/40 p-1">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'potentiella'"
        class="rounded-lg px-4 py-2 text-sm font-medium transition"
        :class="
          tab === 'potentiella'
            ? 'bg-brand-500 text-white'
            : 'text-ink-300 hover:bg-white/5 hover:text-white'
        "
        @click="tab = 'potentiella'"
      >
        Potentiella
        <span class="ml-1 text-xs opacity-75">{{ currentCount }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'ej-aktuella'"
        class="rounded-lg px-4 py-2 text-sm font-medium transition"
        :class="
          tab === 'ej-aktuella'
            ? 'bg-brand-500 text-white'
            : 'text-ink-300 hover:bg-white/5 hover:text-white'
        "
        @click="tab = 'ej-aktuella'"
      >
        Ej aktuella nu
        <span class="ml-1 text-xs opacity-75">{{ parkedCount }}</span>
      </button>
    </nav>

    <p
      v-if="potentialMessage"
      class="mb-4 rounded-xl border px-4 py-3 text-sm"
      :class="
        potentialMessage.tone === 'ok'
          ? 'border-mint-400/30 bg-mint-400/10 text-mint-400'
          : 'border-rose-soft/30 bg-rose-soft/10 text-rose-soft'
      "
    >
      {{ potentialMessage.text }}
    </p>

    <DuplicatePanel v-if="showDuplicates" @merged="refresh()" />

    <section class="card mb-8 p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2">
        <label class="relative min-w-56 flex-1">
          <span class="sr-only">Sök</span>
          <input
            v-model="search"
            type="search"
            placeholder="Sök namn, titel, organisation, kompetens…"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-4 py-2.5 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <select
          v-model="organization"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="">Alla organisationer</option>
          <option v-for="org in data?.facets.organizations" :key="org" :value="org">{{ org }}</option>
        </select>

        <select
          v-model="location"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="">Alla orter</option>
          <option v-for="loc in data?.facets.locations" :key="loc" :value="loc">{{ loc }}</option>
        </select>

        <select
          v-model="seniority"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="">Alla nivåer</option>
          <option v-for="level in data?.facets.seniorities" :key="level" :value="level">
            {{ level }}
          </option>
        </select>

        <button
          type="button"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-300 transition hover:border-brand-500/50 hover:text-white"
          :aria-expanded="showMoreFilters"
          @click="showMoreFilters = !showMoreFilters"
        >
          {{ showMoreFilters ? 'Dölj fler filter' : 'Fler filter' }}
          <span class="ml-1 text-ink-400">{{ showMoreFilters ? '↑' : '↓' }}</span>
        </button>

        <select
          v-model="sort"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="name">Sortera: Namn</option>
          <option value="org">Sortera: Organisation</option>
          <option value="documented">Sortera: Dokumenterad erfarenhet</option>
          <option value="confidence">Sortera: Datakonfidens</option>
        </select>

      </div>

      <div v-if="showMoreFilters" class="mt-3 space-y-3 border-t border-white/8 pt-3">
        <div class="flex flex-wrap items-center gap-2">
          <select
            v-model="minExperience"
            class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
          >
            <option :value="0">Alla erfarenheter</option>
            <option :value="3">Minst 3 år i IT</option>
            <option :value="5">Minst 5 år i IT</option>
            <option :value="10">Minst 10 år i IT</option>
          </select>
          <label
            class="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100"
          >
            <input
              v-model="onlyDocumented"
              type="checkbox"
              class="size-4 accent-brand-500"
            />
            Endast dokumenterad erfarenhet
          </label>
        </div>

        <div v-if="data?.facets.competenceGroups" class="space-y-2">
          <div
            v-for="(tags, category) in data.facets.competenceGroups"
            :key="category"
            class="flex flex-wrap items-center gap-1.5"
          >
            <span class="mr-1 w-40 shrink-0 text-xs uppercase tracking-wide text-ink-400">
              {{ categoryLabels[category] ?? category }}
            </span>
            <button
              v-for="tag in tags"
              :key="tag"
              type="button"
              class="chip transition hover:border-brand-500/50 hover:text-white"
              :class="competences.includes(tag) ? 'border-brand-500/60 bg-brand-500/20 text-white' : ''"
              @click="toggleCompetence(tag)"
            >
              {{ tag }}
            </button>
          </div>
        </div>
      </div>

      <div class="mt-3 flex items-center justify-between text-xs text-ink-400">
        <span>
          Visar {{ tabPeople.length }} av {{ matching.length }}
          <template v-if="tab === 'potentiella'">
            potentiella ({{ currentCount }} totalt)
          </template>
          <template v-else>
            ej aktuella nu ({{ parkedCount }} totalt)
          </template>
          <template v-if="unknownExperience">
            · {{ unknownExperience }} med okänd erfarenhet dold(a)
          </template>
        </span>
        <button
          v-if="hasFilters"
          type="button"
          class="text-ink-300 underline decoration-dotted hover:text-white"
          @click="resetFilters"
        >
          Rensa filter
        </button>
      </div>
    </section>

    <div v-if="status === 'pending'" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="n in 6" :key="n" class="card h-52 animate-pulse bg-white/5" />
    </div>

    <div v-else-if="error" class="card border-rose-soft/30 p-8 text-center">
      <p class="text-lg font-semibold text-rose-soft">Kunde inte hämta data</p>
      <p class="mt-1 text-sm text-ink-300">{{ error.message }}</p>
      <button
        type="button"
        class="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        @click="refresh()"
      >
        Försök igen
      </button>
    </div>

    <div v-else-if="!tabPeople.length" class="card p-12 text-center">
      <p class="text-lg font-semibold text-white">
        {{ tab === 'potentiella' ? 'Inga potentiella kandidater' : 'Inga ej aktuella kandidater' }}
      </p>
      <p class="mt-1 text-sm text-ink-300">
        <template v-if="tab === 'potentiella'">
          Prova en annan sökning eller rensa filtren.
        </template>
        <template v-else>
          Kandidater som inte är aktuella just nu hamnar här - med ett datum för när
          de ska ses över igen.
        </template>
      </p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <PersonCard
        v-for="person in tabPeople"
        :key="person.id"
        :person="person"
        @add-to-pipeline="openAdd"
        @mark-not-current="openPark"
        @reactivate="reactivate"
      />
    </div>

    <!-- Lägg i pipeline -->
    <div
      v-if="addTarget"
      class="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4"
      @click.self="addTarget = null"
    >
      <div class="card w-full max-w-md space-y-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-white">Lägg i pipeline</h2>
          <p class="text-sm text-ink-400">
            {{ addTarget.full_name }}
            <span v-if="addTarget.organization"> · {{ addTarget.organization }}</span>
          </p>
        </div>

        <label class="block space-y-1.5 text-sm">
          <span class="text-ink-300">Roll</span>
          <input
            v-model="addRole"
            type="text"
            placeholder="T.ex. Backend-utvecklare"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <label class="block space-y-1.5 text-sm">
          <span class="text-ink-300">Sökväg</span>
          <select
            v-model="addSource"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
          >
            <option v-for="(label, value) in PIPELINE_SOURCE_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </label>

        <p v-if="addMessage" class="text-sm text-rose-soft">{{ addMessage }}</p>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-white/10 px-3 py-2 text-sm text-ink-300 hover:text-white"
            @click="addTarget = null"
          >
            Avbryt
          </button>
          <button
            type="button"
            class="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40"
            :disabled="addBusy"
            @click="submitAdd"
          >
            Lägg in
          </button>
        </div>
      </div>
    </div>

    <!-- Parka kandidaten - inte aktuell just nu -->
    <div
      v-if="parkTarget"
      class="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4"
      @click.self="closePark"
    >
      <div class="card w-full max-w-md space-y-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-white">Inte aktuell just nu</h2>
          <p class="text-sm text-ink-400">
            {{ parkTarget.full_name }}
            <span v-if="parkTarget.organization"> · {{ parkTarget.organization }}</span>
          </p>
        </div>

        <p class="text-xs text-ink-400">
          Kandidaten flyttas till fliken <span class="text-ink-200">Ej aktuella nu</span> och
          syns där igen när datumet för genomgången kommer.
        </p>

        <p v-if="!adminAuth" class="rounded-lg border border-amber-soft/30 bg-amber-soft/10 px-3 py-2 text-xs text-amber-soft">
          Skrivning kräver adminsession - <a href="/admin" class="underline">logga in på /admin</a>.
        </p>

        <label class="block space-y-1.5 text-sm">
          <span class="text-ink-300">Varför inte aktuell?</span>
          <select
            v-model="parkReason"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
          >
            <option v-for="reason in NOT_RELEVANT_REASONS" :key="reason" :value="reason">
              {{ reason }}
            </option>
          </select>
        </label>

        <label class="block space-y-1.5 text-sm">
          <span class="text-ink-300">Annan anledning (valfritt)</span>
          <input
            v-model="parkNote"
            type="text"
            placeholder="T.ex. driver eget konsultbolag sedan mars"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <label class="block space-y-1.5 text-sm">
          <span class="text-ink-300">Ses över igen</span>
          <input
            v-model="parkDate"
            type="date"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-white focus:border-brand-500 focus:outline-none"
          />
        </label>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-white/10 px-3 py-2 text-sm text-ink-300 hover:text-white"
            :disabled="potentialBusy"
            @click="closePark"
          >
            Avbryt
          </button>
          <button
            type="button"
            class="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40"
            :disabled="potentialBusy || !adminAuth"
            @click="submitPark"
          >
            {{ potentialBusy ? 'Sparar…' : 'Parka' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
