<script setup lang="ts">
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
const showDuplicates = ref(route.query.duplicates === '1')

const people = computed(() => data.value?.people ?? [])

/**
 * Personer med okänd erfarenhet räknas inte som "3+ år" - vi kan inte
 * visa att de klarar filtret. De redovisas i en egen rad under filtren.
 */
const unknownExperience = computed(() =>
  minExperience.value > 0
    ? people.value.filter(p => p.it_experience_years === null).length
    : 0,
)

/** Personer med daterad anställningshistorik - erfarenhet som går att belägga. */
const documentedCount = computed(
  () => people.value.filter(p => p.documented_months > 0).length,
)

const filtered = computed(() => {
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

const orgCount = computed(() => data.value?.facets.organizations.length ?? 0)
const competenceCount = computed(() => data.value?.facets.competences.length ?? 0)
const locationCount = computed(() => data.value?.facets.locations.length ?? 0)

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
            Masterdatabasen – {{ data?.count ?? 0 }} kandidater från {{ orgCount }} organisationer
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

      <dl class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <div class="card px-4 py-3">
          <dt class="text-xs uppercase tracking-wide text-ink-400">Kandidater</dt>
          <dd class="mt-1 text-2xl font-semibold text-white">{{ data?.count ?? 0 }}</dd>
        </div>
        <div class="card px-4 py-3">
          <dt class="text-xs uppercase tracking-wide text-ink-400">Organisationer</dt>
          <dd class="mt-1 text-2xl font-semibold text-white">{{ orgCount }}</dd>
        </div>
        <div class="card px-4 py-3">
          <dt class="text-xs uppercase tracking-wide text-ink-400">Kompetenser</dt>
          <dd class="mt-1 text-2xl font-semibold text-white">{{ competenceCount }}</dd>
        </div>
        <div class="card px-4 py-3">
          <dt class="text-xs uppercase tracking-wide text-ink-400">Orter</dt>
          <dd class="mt-1 text-2xl font-semibold text-white">{{ locationCount }}</dd>
        </div>
        <div class="card px-4 py-3">
          <dt class="text-xs uppercase tracking-wide text-ink-400">Med CV-historia</dt>
          <dd class="mt-1 text-2xl font-semibold text-mint-400">{{ documentedCount }}</dd>
        </div>
      </dl>
    </header>

    <DuplicatePanel v-if="showDuplicates" @merged="refresh()" />

    <section class="card mb-8 space-y-4 p-4">
      <div class="flex flex-wrap gap-3">
        <label class="relative flex-1 min-w-56">
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

        <select
          v-model="minExperience"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option :value="0">Alla erfarenheter</option>
          <option :value="3">Minst 3 år i IT</option>
          <option :value="5">Minst 5 år i IT</option>
          <option :value="10">Minst 10 år i IT</option>
        </select>

        <select
          v-model="sort"
          class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="name">Sortera: Namn</option>
          <option value="org">Sortera: Organisation</option>
          <option value="documented">Sortera: Dokumenterad erfarenhet</option>
          <option value="confidence">Sortera: Datakonfidens</option>
        </select>

        <label
          class="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-ink-100"
        >
          <input
            v-model="onlyDocumented"
            type="checkbox"
            class="size-4 accent-brand-500"
          />
          Endast med dokumenterad erfarenhet
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

      <div class="flex items-center justify-between text-xs text-ink-400">
        <span>
          Visar {{ filtered.length }} av {{ data?.count ?? 0 }}
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

    <div v-else-if="!filtered.length" class="card p-12 text-center">
      <p class="text-lg font-semibold text-white">Inga träffar</p>
      <p class="mt-1 text-sm text-ink-300">Prova en annan sökning eller rensa filtren.</p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <PersonCard v-for="person in filtered" :key="person.id" :person="person" />
    </div>
  </div>
</template>
