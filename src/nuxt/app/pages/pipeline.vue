<script setup lang="ts">
import {
  PIPELINE_STAGES,
} from '#shared/types/pipeline'
import type {
  PipelineCard,
  PipelineResponse,
  PipelineStage,
  PipelineVoter,
  PipelineVoterRole,
  PlannerCard,
} from '#shared/types/pipeline'

/**
 * Rekryteringspipen - en board för alla kandidater som är aktiva.
 *
 * Flödet: Sökt -> Teams-koll -> Granskning -> Kontaktad -> Lunch -> Kritat
 * papper -> Anställd. Bortfall ligger i en egen kolumn, inte i flödet.
 *
 * Boarden är per PERSON, inte per uppdrag. En person kan ha flera roller -
 * då visas en rad per person med en chip per roll, och kolumnen är den roll
 * som kommit längst.
 */
const { data, status, error, refresh } = useFetch<PipelineResponse>('/api/pipeline', {
  key: 'pipeline',
  default: (): PipelineResponse => ({
    cards: [],
    voters: [],
    counts: {},
    droppedCount: 0,
  }),
})

const busy = ref<string | null>(null)
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null)
const dragging = ref<string | null>(null)
const dragOverStage = ref<PipelineStage | null>(null)

/** Vem som röstar - appen har ingen inloggning, så röstaren väljer sitt namn. */
const actorId = useState<string>('pappa-pipeline-actor', () => '')

const actor = computed<PipelineVoter | null>(
  () => data.value?.voters.find(v => v.id === actorId.value) ?? null,
)

const cards = computed(() => data.value?.cards ?? [])
const voters = computed(() => data.value?.voters ?? [])

interface BoardRow {
  personId: string
  cards: PipelineCard[]
  stage: PipelineStage
  lead: PipelineCard
}

/** En rad per person - en person ska aldrig syns som två kort i boarden. */
const rows = computed<BoardRow[]>(() => {
  const byPerson = new Map<string, PipelineCard[]>()
  for (const card of cards.value) {
    if (card.stage === 'dropped') continue
    const list = byPerson.get(card.person_id) ?? []
    list.push(card)
    byPerson.set(card.person_id, list)
  }

  const order = PIPELINE_STAGES.map(s => s.stage)
  return [...byPerson.entries()].map(([personId, list]) => {
    const sorted = [...list].sort((a, b) => order.indexOf(b.stage) - order.indexOf(a.stage))
    const lead = sorted[0]
    if (!lead) return null
    return { personId, cards: list, stage: lead.stage, lead }
  }).filter((row): row is BoardRow => row !== null)
})

function cardsFor(stage: PipelineStage): BoardRow[] {
  return rows.value.filter(row => row.stage === stage)
}

const droppedCards = computed(() => cards.value.filter(c => c.stage === 'dropped'))

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  // Nitros typade routes går inte att anropa med en variabel sökväg utan
  // att TypeScript exploderar i "excessive stack depth" - därför Any.
  const response = await $fetch(path as any, { method: 'POST', body })
  return response as T
}

function errorText(err: unknown): string {
  const e = err as {
    data?: { message?: string; statusCode?: number }
    statusMessage?: string
    statusCode?: number
  }
  const base = e.data?.message ?? e.statusMessage ?? 'Något gick fel.'
  const status = e.statusCode ?? e.data?.statusCode
  return status === 401 ? `${base} Logga in på /admin.` : base
}

// ---------------------------------------------------------------------------
// Drag och drop mellan kolumner - ett kort i taget flyttas
// ---------------------------------------------------------------------------
function onDragStart(cardId: string) {
  dragging.value = cardId
}

function onDrop(stage: PipelineStage) {
  const cardId = dragging.value
  dragging.value = null
  dragOverStage.value = null
  if (!cardId) return

  const card = cards.value.find(c => c.id === cardId)
  if (!card || card.stage === stage) return

  if (stage === 'dropped') {
    void dropCard(card)
    return
  }

  void moveCard(card, stage)
}

async function moveCard(card: PipelineCard, to: PipelineStage) {
  busy.value = card.id
  try {
    await call('/api/pipeline', {
      op: 'move',
      id: card.id,
      stage: to,
      actor: actor.value?.name ?? null,
    })
    await refresh()
  } catch (err) {
    message.value = { tone: 'error', text: errorText(err) }
  } finally {
    busy.value = null
  }
}

/** Bortfall - kortet försvinner ur flödet, men orsaken sparas. */
async function dropCard(card: PipelineCard) {
  const reason = prompt('Varför försvinner kandidaten?')
  if (reason === null) return

  busy.value = card.id
  try {
    await call('/api/pipeline', {
      op: 'drop',
      id: card.id,
      reason: reason.trim() || 'Okänd orsak',
      actor: actor.value?.name ?? null,
    })
    await refresh()
  } catch (err) {
    message.value = { tone: 'error', text: errorText(err) }
  } finally {
    busy.value = null
  }
}

async function vote(card: PipelineCard, role: PipelineVoterRole, approved: boolean) {
  if (!actor.value) {
    message.value = { tone: 'error', text: 'Välj dig som rörare först (toppen av sidan).' }
    return
  }
  busy.value = card.id
  try {
    await call('/api/pipeline/vote', {
      pipeline_id: card.id,
      voter_id: actor.value.id,
      approved,
    })
    await refresh()
  } catch (err) {
    message.value = { tone: 'error', text: errorText(err) }
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------------------
// Planner-listan ("Rekrytering") - import och omatchade kort
// ---------------------------------------------------------------------------
const planner = useFetch<{ cards: PlannerCard[]; matched: number; unmatched: number }>(
  '/api/planner',
  {
    key: 'planner',
    default: () => ({ cards: [], matched: 0, unmatched: 0 }),
  },
)

const plannerCards = computed(() => planner.data.value?.cards ?? [])
const plannerMatched = computed(() => planner.data.value?.matched ?? 0)
const plannerUnmatched = computed(() => planner.data.value?.unmatched ?? 0)

const showPlanner = ref(false)
const csvText = ref('')
const csvName = ref('')

function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  csvName.value = file.name
  file.text().then(text => {
    csvText.value = text
  })
}

async function importCsv() {
  if (!csvText.value.trim()) return
  busy.value = 'import'
  try {
    const result = await call<{ imported: number; matched: number; unmatched: number }>(
      '/api/planner/import',
      { csv: csvText.value },
    )
    message.value = {
      tone: 'ok',
      text: `Importerade ${result.imported} kort - ${result.matched} matchade, ${result.unmatched} är omatchade.`,
    }
    csvText.value = ''
    csvName.value = ''
    await Promise.all([refresh(), planner.refresh()])
  } catch (err) {
    message.value = { tone: 'error', text: errorText(err) }
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------------------
// Rörare
// ---------------------------------------------------------------------------
const newVoterName = ref('')
const newVoterRole = ref<PipelineVoterRole>('employee')

async function addVoter() {
  if (!newVoterName.value.trim()) return
  try {
    await call('/api/pipeline/voters', {
      name: newVoterName.value.trim(),
      role: newVoterRole.value,
    })
    newVoterName.value = ''
    await refresh()
  } catch (err) {
    message.value = { tone: 'error', text: errorText(err) }
  }
}

useHead({
  title: 'Pappa – Pipeline',
  meta: [{ name: 'description', content: 'Rekryteringspipen - kanban över kandidater.' }],
})
</script>

<template>
  <div class="mx-auto max-w-[110rem] px-5 py-10 sm:px-8">
    <header class="mb-8 space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <span
          class="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-mint-400 text-lg font-bold text-ink-950 shadow-lg shadow-brand-500/25"
        >
          🗂️
        </span>
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Pipeline</h1>
          <p class="text-sm text-ink-400">
            {{ cards.length }} kort · {{ droppedCards.length }} bortfall
          </p>
        </div>

        <label class="ml-auto flex items-center gap-2 text-sm text-ink-300">
          <span>Rörare</span>
          <select
            v-model="actorId"
            class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
          >
            <option value="">Välj dig…</option>
            <option v-for="voter in voters" :key="voter.id" :value="voter.id">
              {{ voter.name }} ({{ voter.role === 'founder' ? 'grundare' : 'anställd' }})
            </option>
          </select>
        </label>

        <button
          type="button"
          class="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
          @click="showPlanner = !showPlanner"
        >
          🪪 Planner-lista
        </button>
        <button
          type="button"
          class="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
          @click="refresh()"
        >
          ↻ Uppdatera
        </button>
      </div>

      <p
        v-if="message"
        class="rounded-xl border px-3 py-2 text-sm"
        :class="
          message.tone === 'ok'
            ? 'border-mint-400/30 bg-mint-400/10 text-mint-400'
            : 'border-rose-soft/30 bg-rose-soft/10 text-rose-soft'
        "
      >
        {{ message.text }}
      </p>

      <!-- Planner-import -->
      <section v-if="showPlanner" class="card space-y-3 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-sm font-semibold text-white">Teams/Planner-listan "Rekrytering"</h2>
          <span class="text-xs text-ink-400">
            {{ plannerMatched }} matchade · {{ plannerUnmatched }} omatchade
          </span>
        </div>

        <p class="text-xs leading-relaxed text-ink-400">
          Exportera boarden ur Planner till CSV och ladda upp här. Korten matchas mot
          personregistret automatiskt - men en människa linker de som inte matchar.
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept=".csv,text/csv"
            class="text-xs text-ink-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-500 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
            @change="onFile"
          />
          <span v-if="csvName" class="text-xs text-ink-400">{{ csvName }}</span>
          <button
            type="button"
            class="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40"
            :disabled="!csvText || busy === 'import'"
            @click="importCsv"
          >
            Importera
          </button>
        </div>

        <ul v-if="plannerCards.length" class="space-y-1.5 text-xs">
          <li
            v-for="card in plannerCards"
            :key="card.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-1.5"
          >
            <span class="font-medium text-white">{{ card.title }}</span>
            <span v-if="card.match_kind" class="text-ink-400">
              {{ card.person_name }} ({{ card.match_kind }}
              {{ Math.round((card.match_score ?? 0) * 100) }}%)
            </span>
            <span v-else class="text-amber-soft">Omatchad - länka manuellt</span>
          </li>
        </ul>
      </section>

      <!-- Rörare -->
      <section class="card flex flex-wrap items-center gap-2 p-3 text-sm">
        <span class="text-ink-300">Rörare:</span>
        <input
          v-model="newVoterName"
          type="text"
          placeholder="Namn"
          class="rounded-lg border border-white/10 bg-ink-950/60 px-3 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
        />
        <select
          v-model="newVoterRole"
          class="rounded-lg border border-white/10 bg-ink-950/60 px-3 py-1.5 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
        >
          <option value="employee">Anställd</option>
          <option value="founder">Grundare</option>
        </select>
        <button
          type="button"
          class="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-ink-200 hover:border-brand-500/50 hover:text-white"
          @click="addVoter"
        >
          Lägg till
        </button>
        <span class="text-xs text-ink-400">
          {{ voters.filter(v => v.role === 'employee').length }} anställda ·
          {{ voters.filter(v => v.role === 'founder').length }} grundare
        </span>
      </section>
    </header>

    <div v-if="status === 'pending'" class="grid gap-4 sm:grid-cols-4">
      <div v-for="n in 4" :key="n" class="card h-64 animate-pulse bg-white/5" />
    </div>

    <div v-else-if="error" class="card border-rose-soft/30 p-8 text-center">
      <p class="text-lg font-semibold text-rose-soft">Kunde inte hämta pipen</p>
      <p class="mt-1 text-sm text-ink-300">{{ error.message }}</p>
    </div>

    <div v-else class="flex gap-4 overflow-x-auto pb-6">
      <section
        v-for="column in PIPELINE_STAGES"
        :key="column.stage"
        class="flex w-80 shrink-0 flex-col gap-3 rounded-2xl border border-white/8 bg-ink-900/40 p-3"
        :class="dragOverStage === column.stage ? 'border-brand-500/60' : ''"
        @dragover.prevent="dragOverStage = column.stage"
        @dragleave="dragOverStage = null"
        @drop.prevent="onDrop(column.stage)"
      >
        <header class="flex items-center justify-between px-1">
          <h2 class="text-sm font-semibold text-white">
            {{ column.icon }} {{ column.label }}
          </h2>
          <span
            class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-ink-300"
          >
            {{ cardsFor(column.stage).length }}
          </span>
        </header>

        <div class="flex flex-1 flex-col gap-2.5">
          <div
            v-for="row in cardsFor(column.stage)"
            :key="row.personId"
            @dragend="dragging = null"
          >
            <PipelineCard
              :card="row.lead"
              :actor="actor"
              @drag-start="onDragStart"
              @vote="(role, approved) => vote(row.lead, role, approved)"
              @drop="dropCard(row.lead)"
            />
            <!-- Ytterligare roller för samma person visas under huvudkortet. -->
            <div v-if="row.cards.length > 1" class="mt-1.5 space-y-1.5 pl-1">
              <PipelineCard
                v-for="extra in row.cards.filter(c => c.id !== row.lead.id)"
                :key="extra.id"
                :card="extra"
                :actor="actor"
                @drag-start="onDragStart"
                @vote="(role, approved) => vote(extra, role, approved)"
                @drop="dropCard(extra)"
              />
            </div>
          </div>

          <p v-if="!cardsFor(column.stage).length" class="px-1 text-xs text-ink-400">
            Inga kort.
          </p>
        </div>
      </section>

      <section
        class="flex w-72 shrink-0 flex-col gap-3 rounded-2xl border border-rose-soft/20 bg-rose-soft/5 p-3"
        :class="dragOverStage === 'dropped' ? 'border-rose-soft/60' : ''"
        @dragover.prevent="dragOverStage = 'dropped'"
        @dragleave="dragOverStage = null"
        @drop.prevent="onDrop('dropped')"
      >
        <header class="flex items-center justify-between px-1">
          <h2 class="text-sm font-semibold text-rose-soft">🚫 Bortfall</h2>
          <span
            class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-ink-300"
          >
            {{ droppedCards.length }}
          </span>
        </header>
        <div class="flex flex-1 flex-col gap-2.5">
          <PipelineCard
            v-for="card in droppedCards"
            :key="card.id"
            :card="card"
            :actor="actor"
          />
          <p class="px-1 text-xs text-ink-400">Släpp ett kort här för att markera bortfall.</p>
        </div>
      </section>
    </div>
  </div>
</template>
