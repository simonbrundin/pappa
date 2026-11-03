<script setup lang="ts">
import type { DuplicateCandidate, DuplicateSide, DuplicatesResponse } from '#shared/types/people'

const emit = defineEmits<{ merged: [] }>()

// Hämtas på servern så att knapterna syns direkt - listan är liten
// (några hundra par) och innehåller inga hemligheter.
const { data, status, error, refresh } = useFetch<DuplicatesResponse>('/api/duplicates', {
  key: 'duplicates',
  default: (): DuplicatesResponse => ({ candidates: [], weak: [], count: 0, weakCount: 0 }),
})

/**
 * Admin-token. Lagras i sessionStorage (aldrig i localStorage) och skickas
 * som header. Utan token går det att läsa kandidaterna, men inte att
 * slå ihop - skrivning mot masterdatabasen ska aldrig vara publik.
 *
 * Delas med vyn "Uppdrag" via useAdminToken, så token sätts en gång.
 */
const { token, input: tokenInput, load: loadToken, save: saveTokenRaw, headers } = useAdminToken()
const busy = ref<string | null>(null)
const message = ref<{ tone: 'ok' | 'error'; text: string } | null>(null)
/** Visa de svaga paren (gemensamt förnamn/efternamn). */
const showWeak = ref(false)

onMounted(loadToken)

function saveToken() {
  saveTokenRaw(tokenInput.value)
  message.value = token.value
    ? { tone: 'ok', text: 'Token sparad för den här webbläsarsessionen.' }
    : { tone: 'error', text: 'Tomt token - sammanslagning är avstängd.' }
}

const candidates = computed(() => data.value?.candidates ?? [])
const weak = computed(() => data.value?.weak ?? [])

/** Starkare signaler först - de är nästan alltid riktiga dubbletter. */
const sorted = computed(() => [...candidates.value].sort((a, b) => b.score - a.score))

const signalTone: Record<string, string> = {
  'samma e-post': 'bg-rose-soft/15 text-rose-soft border-rose-soft/30',
  'samma telefon': 'bg-rose-soft/15 text-rose-soft border-rose-soft/30',
  'samma namn': 'bg-amber-soft/15 text-amber-soft border-amber-soft/30',
  'samma namn, utökad form': 'bg-amber-soft/15 text-amber-soft border-amber-soft/30',
  'samma namn, 1-3 tecken fel': 'bg-amber-soft/15 text-amber-soft border-amber-soft/30',
  'gemensamt förnamn': 'bg-white/5 text-ink-400 border-white/10',
  'gemensamt efternamn': 'bg-white/5 text-ink-400 border-white/10',
  'liknande förnamn': 'bg-white/5 text-ink-400 border-white/10',
  'liknande efternamn': 'bg-white/5 text-ink-400 border-white/10',
  'liknande namn': 'bg-white/5 text-ink-400 border-white/10',
}

function sideOf(candidate: DuplicateCandidate, side: 'a' | 'b'): DuplicateSide {
  return side === 'a' ? candidate.a : candidate.b
}

function pairKey(candidate: DuplicateCandidate): string {
  return `${candidate.id_a}:${candidate.id_b}`
}

async function merge(candidate: DuplicateCandidate, keep: 'a' | 'b') {
  const keepSide = sideOf(candidate, keep)
  const dropSide = sideOf(candidate, keep === 'a' ? 'b' : 'a')

  if (!confirm(`Slå ihop "${dropSide.name}" in i "${keepSide.name}"?\n\nAlla källor, kompetenser och anställningar flyttas till "${keepSide.name}". Posten "${dropSide.name}" raderas och kommer inte tillbaka vid nästa import.`)) {
    return
  }

  busy.value = pairKey(candidate)
  message.value = null
  try {
    const result = await $fetch<Record<string, unknown>>('/api/duplicates/merge', {
      method: 'POST',
      headers: headers(),
      body: { a_id: candidate.id_a, b_id: candidate.id_b, keep },
    })
    message.value = {
      tone: 'ok',
      text: `Sammanslaget: ${result.dropped_name ?? dropSide.name} → ${result.kept_name ?? keepSide.name}. ` +
        `${result.sources_moved ?? 0} källor och ${result.employments_moved ?? 0} anställningsrader flyttades.`,
    }
    await refresh()
    emit('merged')
  } catch (err: unknown) {
    const e = err as { data?: { message?: string }; statusMessage?: string }
    message.value = {
      tone: 'error',
      text: e.data?.message ?? e.statusMessage ?? 'Kunde inte slå ihop posterna.',
    }
  } finally {
    busy.value = null
  }
}

/** Markera paret som "behåll båda" - de är olika personer. */
async function keepBoth(candidate: DuplicateCandidate) {
  const nameA = sideOf(candidate, 'a').name
  const nameB = sideOf(candidate, 'b').name
  if (!confirm(`Behåll båda "${nameA}" och "${nameB}"?\n\nParet markeras som olika personer och visas inte igen.`)) {
    return
  }

  busy.value = pairKey(candidate)
  message.value = null
  try {
    await $fetch('/api/duplicates/dismiss', {
      method: 'POST',
      headers: headers(),
      body: { a_id: candidate.id_a, b_id: candidate.id_b },
    })
    message.value = { tone: 'ok', text: `Markerat som olika personer: ${nameA} och ${nameB}.` }
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string }; statusMessage?: string }
    message.value = {
      tone: 'error',
      text: e.data?.message ?? e.statusMessage ?? 'Kunde inte markera paret.',
    }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="card mb-8 p-5">
    <header class="mb-4 flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold text-white">Dubbletter</h2>
      <span class="chip">{{ sorted.length }} kandidatpar</span>
      <span v-if="weak.length" class="chip">
        {{ weak.length }} par med gemensamt förnamn/efternamn
      </span>
      <button
        type="button"
        class="ml-auto rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-brand-500/50 hover:text-white"
        @click="refresh()"
      >
        ↻ Sök igen
      </button>
    </header>

    <p class="mb-4 rounded-xl border border-amber-soft/25 bg-amber-soft/10 px-4 py-3 text-xs leading-relaxed text-ink-100">
      En kandidat kräver att <strong>både förnamn och efternamn</strong> stämmer (eller att
      e-post/telefon är identiska). Ett gemensamt förnamn räcker inte - "Mikael Gidlund" och
      "Mikael Nordlund" är två personer. Inget slås ihop automatiskt.
    </p>

    <div class="mb-4 flex flex-wrap items-end gap-2">
      <label class="flex-1 min-w-56">
        <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">Admin-token</span>
        <input
          v-model="tokenInput"
          type="password"
          placeholder="NUXT_ADMIN_TOKEN"
          class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
        />
      </label>
      <button
        type="button"
        class="rounded-xl border border-white/10 px-3 py-2 text-sm text-ink-100 transition hover:border-brand-500/50"
        @click="saveToken"
      >
        Spara token
      </button>
      <span v-if="!token" class="text-xs text-rose-soft">
        Utan token går det att läsa, men inte att slå ihop.
      </span>
    </div>

    <p
      v-if="message"
      class="mb-4 rounded-xl px-4 py-3 text-xs"
      :class="message.tone === 'ok'
        ? 'border border-mint-400/30 bg-mint-400/10 text-mint-400'
        : 'border border-rose-soft/30 bg-rose-soft/10 text-rose-soft'"
    >
      {{ message.text }}
    </p>

    <div v-if="status === 'pending'" class="text-sm text-ink-400">Söker…</div>
    <div v-else-if="error" class="text-sm text-rose-soft">
      Kunde inte hämta dubbletter: {{ error.message }}
    </div>
    <p v-else-if="!sorted.length" class="text-sm text-ink-400">
      Inga dubblettkandidater hittades. Bra - inget att slå ihop.
    </p>

    <ul v-else class="space-y-4">
      <li
        v-for="candidate in sorted"
        :key="pairKey(candidate)"
        class="rounded-xl border border-white/8 bg-ink-950/40 p-4"
      >
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <span
            class="rounded-full border px-2.5 py-0.5 text-xs"
            :class="signalTone[candidate.signal] ?? signalTone['liknande namn']"
          >
            {{ candidate.signal }}
          </span>
          <span v-if="candidate.shared_competences" class="text-xs text-ink-400">
            · {{ candidate.shared_competences }} gemensamma kompetenser
          </span>
          <span v-if="candidate.same_org" class="text-xs text-ink-400">· samma bolag</span>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div
            v-for="side in (['a', 'b'] as const)"
            :key="side"
            class="rounded-lg border border-white/8 bg-ink-900/60 p-3"
          >
            <p class="font-medium text-white">{{ sideOf(candidate, side).name }}</p>
            <p class="text-xs text-ink-400">
              {{ sideOf(candidate, side).title ?? '—' }}
              <template v-if="sideOf(candidate, side).organization">
                · {{ sideOf(candidate, side).organization }}
              </template>
            </p>
            <p class="mt-1 text-xs text-ink-300">
              <span v-if="sideOf(candidate, side).email">{{ sideOf(candidate, side).email }}</span>
              <span v-else class="text-ink-400">ingen publicerad e-post</span>
            </p>
            <p class="mt-1 text-xs text-ink-400">
              {{ sideOf(candidate, side).employments }} anställningsrader ·
              {{ sideOf(candidate, side).sources }} källor
            </p>
            <button
              type="button"
              class="mt-3 w-full rounded-lg border border-brand-500/40 px-3 py-1.5 text-xs text-brand-400 transition hover:bg-brand-500/15 hover:text-white disabled:opacity-40"
              :disabled="busy !== null"
              @click="merge(candidate, side)"
            >
              Slå ihop - behåll den här
            </button>
          </div>
        </div>

        <button
          type="button"
          class="mt-3 w-full rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-300 transition hover:border-white/25 hover:text-white disabled:opacity-40"
          :disabled="busy !== null"
          @click="keepBoth(candidate)"
        >
          Behåll båda - det är två olika personer
        </button>
      </li>
    </ul>

    <div v-if="weak.length" class="mt-6 border-t border-white/8 pt-4">
      <button
        type="button"
        class="flex w-full items-center justify-between text-left text-xs text-ink-400 transition hover:text-white"
        @click="showWeak = !showWeak"
      >
        <span>
          {{ showWeak ? '▾' : '▸' }}
          {{ weak.length }} par med bara ett gemensamt förnamn eller efternamn
        </span>
        <span class="text-ink-400">visas inte som dubbletter</span>
      </button>

      <p class="mt-2 text-xs leading-relaxed text-ink-400">
        Här stämmer bara en av namndelarna - nästan alltid olika personer (släktingar i
        samma bolag, eller samma förnamn). Markera som "behåll båda" om du känner igen
        dem, så försvinner de ur listan.
      </p>

      <ul v-if="showWeak" class="mt-3 space-y-2">
        <li
          v-for="candidate in weak"
          :key="pairKey(candidate)"
          class="flex flex-wrap items-center gap-3 rounded-lg border border-white/8 bg-ink-950/30 px-3 py-2"
        >
          <span class="text-xs text-ink-300">
            {{ candidate.name_a }}
            <span class="text-ink-400">· {{ candidate.org_a ?? '—' }}</span>
          </span>
          <span class="text-xs text-ink-400">och</span>
          <span class="text-xs text-ink-300">
            {{ candidate.name_b }}
            <span class="text-ink-400">· {{ candidate.org_b ?? '—' }}</span>
          </span>
          <span class="chip text-[11px]">{{ candidate.signal }}</span>
          <button
            type="button"
            class="ml-auto rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-ink-300 transition hover:border-white/25 hover:text-white disabled:opacity-40"
            :disabled="busy !== null"
            @click="keepBoth(candidate)"
          >
            Behåll båda
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
