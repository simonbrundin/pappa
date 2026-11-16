<script setup lang="ts">
import type { CvEntry, Person } from '#shared/types/people'

const props = defineProps<{ person: Person }>()

const emit = defineEmits<{ 'add-to-pipeline': [person: Person] }>()

/** Kort etikett för pipeline-stegen på personkortet. */
const stageLabel: Record<string, string> = {
  sourced: '🔍 Sökt',
  teams_check: '🪪 Teams-koll',
  review: '👍 Granskning',
  contacted: '✉️ Kontaktad',
  lunch: '🍽️ Lunch',
  paper: '🥂 Kritat papper',
  hired: '✅ Anställd',
  dropped: '🚫 Bortfall',
}

const open = ref(false)

const initials = computed(() =>
  props.person.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join(''),
)

/** Deterministisk gradient per person, så att korten är igenkännbara utan bild. */
const hue = computed(() => {
  const text = props.person.external_id || props.person.full_name
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360
  return hash
})

const canContact = computed(
  () => props.person.contact_published && !props.person.do_not_contact && !!props.person.email,
)

const confidenceTone = computed(() => {
  switch (props.person.data_confidence) {
    case 'high':
      return 'bg-mint-400/15 text-mint-400 border-mint-400/25'
    case 'medium':
      return 'bg-amber-soft/15 text-amber-soft border-amber-soft/25'
    default:
      return 'bg-rose-soft/15 text-rose-soft border-rose-soft/25'
  }
})

const kindLabel: Record<string, string> = {
  consultancy: 'Konsult',
  public_sector: 'Offentlig',
  industry: 'Privat',
  academia: 'Akademi',
  vendor: 'Leverantör',
  other: 'Övrigt',
}

/** "2011–2017", "2024–" (pågående), "Period okänd". */
function formatPeriod(entry: CvEntry): string {
  const from = entry.valid_from?.slice(0, 4)
  const to = entry.valid_to?.slice(0, 4)
  if (from && to) return `${from}–${to}`
  if (from) return `${from}–`
  if (to) return `–${to}`
  return 'Period okänd'
}

/** Längd i läsbar form: "7 år", "6 mån", "okänt". */
function formatMonths(months: number | null): string {
  if (months === null || months === undefined) return 'okänt'
  if (months < 12) return `${months} mån`
  const years = Math.floor(months / 12)
  const rest = months % 12
  return rest ? `${years} år ${rest} mån` : `${years} år`
}

const documentedYears = computed(() =>
  props.person.documented_months > 0
    ? (props.person.documented_months / 12).toFixed(1).replace('.', ',')
    : null,
)

const employmentTypeLabel: Record<string, string> = {
  employment: 'Anställd',
  freelance: 'Frilans',
  consultant: 'Konsult',
  project: 'Projekt',
  education: 'Utbildning',
}
</script>

<template>
  <article
    class="card group flex flex-col gap-4 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-brand-500/40 hover:shadow-[0_12px_40px_-12px_rgba(79,124,255,0.45)]"
  >
    <header class="flex items-start gap-3">
      <div
        class="grid size-11 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white shadow-inner"
        :style="{
          backgroundImage: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 75% 38%))`,
        }"
      >
        {{ initials }}
      </div>

      <div class="min-w-0 flex-1">
        <h3 class="truncate text-base font-semibold text-white">{{ person.full_name }}</h3>
        <p class="truncate text-sm text-ink-300">
          {{ person.title || '—' }}
          <span v-if="person.seniority" class="text-ink-400">· {{ person.seniority }}</span>
        </p>
      </div>

      <span
        class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize"
        :class="confidenceTone"
      >
        {{ person.data_confidence || 'okänt' }}
      </span>
    </header>

    <dl class="space-y-1.5 text-sm">
      <div class="flex items-center gap-2 text-ink-300">
        <dt class="w-5 shrink-0 text-center text-ink-400">◧</dt>
        <dd class="truncate">
          {{ person.organization || 'Okänd organisation' }}
          <span
            v-if="person.organization_kind"
            class="ml-1 text-xs text-ink-400"
          >({{ kindLabel[person.organization_kind] || person.organization_kind }})</span>
        </dd>
      </div>
      <div class="flex items-center gap-2 text-ink-300">
        <dt class="w-5 shrink-0 text-center text-ink-400">⌖</dt>
        <dd class="truncate">
          {{ person.location || 'Okänd ort' }}
          <span v-if="person.location_confidence" class="ml-1 text-xs text-ink-400">
            ({{ person.location_confidence }})
          </span>
        </dd>
      </div>
      <div class="flex items-center gap-2 text-ink-300">
        <dt class="w-5 shrink-0 text-center text-ink-400">◷</dt>
        <dd class="truncate">
          <template v-if="person.it_experience_years !== null">
            {{ person.it_experience_years }}+ år i IT
            <span
              v-if="person.it_experience_basis === 'seniority'"
              class="ml-1 text-xs text-ink-400"
              title="Uppskattad från rollnivå - inte dokumenterad erfarenhet"
            >(uppskattat)</span>
          </template>
          <template v-else>Okänd erfarenhet</template>
          <span
            v-if="documentedYears"
            class="ml-1 text-xs text-mint-400"
            :title="`${formatMonths(person.documented_months)} dokumenterad anställningstid`"
          >· {{ documentedYears }} år dokumenterat</span>
        </dd>
      </div>
      <div v-if="person.available_from" class="flex items-center gap-2 text-ink-300">
        <dt class="w-5 shrink-0 text-center text-ink-400">▸</dt>
        <dd class="truncate">Tillgänglig från {{ person.available_from }}</dd>
      </div>
    </dl>

    <ul v-if="person.competences.length" class="flex flex-wrap gap-1.5">
      <li v-for="competence in person.competences" :key="competence" class="chip">
        {{ competence }}
      </li>
    </ul>

    <!-- Pipeline: steg och roller personen är aktuell för. -->
    <ul v-if="person.pipeline_stages?.length" class="flex flex-wrap gap-1.5">
      <li
        v-for="stage in person.pipeline_stages"
        :key="stage"
        class="chip border-brand-500/40 bg-brand-500/15 text-white"
      >
        {{ stageLabel[stage] ?? stage }}
      </li>
      <li v-for="role in person.pipeline_roles ?? []" :key="role" class="chip">
        {{ role }}
      </li>
    </ul>

    <footer class="mt-auto flex flex-wrap items-center gap-2 pt-1">
      <a
        v-if="canContact"
        :href="`mailto:${person.email}`"
        class="inline-flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-2.5 py-1.5 text-xs font-medium text-brand-400 transition hover:bg-brand-500/25"
      >
        ✉ {{ person.email }}
      </a>
      <span
        v-else-if="person.do_not_contact"
        class="rounded-lg bg-rose-soft/10 px-2.5 py-1.5 text-xs text-rose-soft"
      >
        Ingen kontakt
      </span>
      <span
        v-else
        class="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-ink-400"
      >
        Kontaktuppgifter ej publicerade
      </span>

      <button
        type="button"
        class="ml-auto text-xs text-ink-400 transition hover:text-brand-400"
        @click="open = !open"
      >
        {{ open ? 'Dölj' : person.cv.length ? 'CV & källa' : 'Källa' }} ▾
      </button>

      <button
        type="button"
        class="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-ink-300 transition hover:bg-brand-500/20 hover:text-white"
        @click="emit('add-to-pipeline', person)"
      >
        🗂️ Pipeline
      </button>
    </footer>

    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="space-y-3 border-t border-white/8 pt-3 text-xs text-ink-400">
        <div v-if="person.cv.length" class="space-y-2">
          <p class="uppercase tracking-wide text-ink-500">Anställningshistorik</p>
          <ul class="space-y-2">
            <li
              v-for="(entry, i) in person.cv"
              :key="entry.ref ?? `${entry.title}-${i}`"
              class="rounded-lg bg-white/5 px-2.5 py-2"
            >
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="font-medium text-ink-100">
                  {{ entry.title || entry.organization || 'Okänd roll' }}
                </span>
                <span v-if="entry.title && entry.organization" class="text-ink-400">
                  {{ entry.organization }}
                </span>
                <span class="ml-auto tabular-nums text-ink-500">
                  {{ formatPeriod(entry) }} · {{ formatMonths(entry.months) }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span v-if="entry.employment_type" class="text-ink-500">
                  {{ employmentTypeLabel[entry.employment_type] ?? entry.employment_type }}
                </span>
                <span v-if="entry.is_current" class="text-mint-400">Pågående</span>
                <span
                  v-if="entry.confidence === 'low'"
                  class="text-amber-soft"
                  title="Hypotes - raden behöver verifieras"
                >osäker</span>
                <span v-for="tag in entry.stack" :key="tag" class="chip">{{ tag }}</span>
                <a
                  v-if="entry.source_url"
                  :href="entry.source_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-brand-400/90 hover:underline"
                >källa</a>
              </div>
              <p v-if="entry.note" class="mt-1 text-[11px] text-ink-500">{{ entry.note }}</p>
            </li>
          </ul>
        </div>

        <div class="space-y-1.5">
          <p>
            {{ person.source_count }} {{ person.source_count === 1 ? 'källa' : 'källor' }}
            <template v-if="person.retention_until"> · sparas till {{ person.retention_until }}</template>
          </p>
          <ul v-if="person.source_urls.length" class="space-y-1">
            <li v-for="url in person.source_urls" :key="url" class="truncate">
              <a :href="url" target="_blank" rel="noopener noreferrer" class="text-brand-400/90 hover:underline">
                {{ url }}
              </a>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </article>
</template>
