<script setup lang="ts">
import type { PipelineCard, PipelineVoter, PipelineVoterRole } from '#shared/types/pipeline'

const props = defineProps<{
  card: PipelineCard
  /** Vem som röstar just nu - appen har ingen inloggning. */
  actor: PipelineVoter | null
}>()

const emit = defineEmits<{
  vote: [role: PipelineVoterRole, approved: boolean]
  drop: []
  'drag-start': [cardId: string]
}>()

/** Dagar i nuvarande steg - "ligger kvar" är det viktigaste att se. */
const daysInStage = computed(() => {
  const entered = new Date(props.card.entered_stage_at).getTime()
  if (Number.isNaN(entered)) return 0
  return Math.max(0, Math.round((Date.now() - entered) / 86_400_000))
})

/** Kontaktuppgifterna visas först när man ber om det (GDPR). */
const showContact = ref(false)

/** En röst får bara läggas av någon med rätt roll. */
function canVote(role: PipelineVoterRole): boolean {
  return props.actor?.role === role
}

const sourceLabels: Record<string, string> = {
  linkedin: 'LinkedIn',
  arbetsforrmedlingen: 'Arbetsförmedlingen',
  boolag: 'Boolag',
  myndighet: 'Myndighet',
  it_bolag_sundsvall: 'IT-bolag',
  soulmate_kontakt: 'Soulmate-kontakt',
  annat: 'Annat',
}
</script>

<template>
  <article
    class="card group flex flex-col gap-2.5 p-3.5 text-sm transition hover:border-brand-500/40"
    draggable="true"
    @dragstart="emit('drag-start', card.id)"
  >
    <header class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h3 class="truncate font-semibold text-white">{{ card.full_name }}</h3>
        <p class="truncate text-xs text-ink-400">
          {{ card.title || '—' }}
          <span v-if="card.organization"> · {{ card.organization }}</span>
        </p>
      </div>
      <span
        class="shrink-0 rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-ink-400"
        :title="`I steget i ${daysInStage} dagar`"
      >
        {{ daysInStage }}d
      </span>
    </header>

    <div class="flex flex-wrap gap-1.5">
      <span class="chip">{{ card.role_label }}</span>
      <span class="chip">{{ sourceLabels[card.source] ?? card.source }}</span>
      <span
        v-if="card.teams_ref"
        class="chip border-amber-soft/30 bg-amber-soft/15 text-amber-soft"
        title="Kandidaten finns redan i Planner-listan"
      >
        🪪 I Planner
      </span>
      <span
        v-if="card.owner_name"
        class="chip border-mint-400/25 bg-mint-400/10 text-mint-400"
      >
        {{ card.owner_name }}
      </span>
      <span
        v-if="card.do_not_contact"
        class="chip border-rose-soft/30 bg-rose-soft/15 text-rose-soft"
      >
        Ej kontaktbar
      </span>
    </div>

    <!-- Granskning: en anställd och en grundare måste rösta ja. -->
    <div v-if="card.stage === 'review'" class="space-y-1.5 rounded-xl border border-white/10 bg-ink-950/40 p-2">
      <p class="text-[11px] uppercase tracking-wide text-ink-400">Granskning</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="role in (['employee', 'founder'] as PipelineVoterRole[])"
          :key="role"
          type="button"
          class="chip transition"
          :class="[
            card.votes[role]?.approved
              ? 'border-mint-400/40 bg-mint-400/15 text-mint-400'
              : card.votes[role]
                ? 'border-rose-soft/40 bg-rose-soft/15 text-rose-soft'
                : '',
            canVote(role) ? 'hover:border-brand-500/60' : 'opacity-50',
          ]"
          :disabled="!canVote(role)"
          :title="
            card.votes[role]
              ? `${card.votes[role].voter_name}: ${card.votes[role].approved ? 'ja' : 'nej'}`
              : canVote(role)
                ? 'Rösta ja'
                : 'Välj dig som rörare i toppen'
          "
          @click="emit('vote', role, true)"
        >
          {{ role === 'employee' ? '👍 Anställd' : '👍 Grundare' }}
          <template v-if="card.votes[role]">
            {{ card.votes[role].approved ? '✓' : '✗' }}
          </template>
        </button>
      </div>
      <button
        type="button"
        class="text-[11px] text-rose-soft underline decoration-dotted hover:text-white disabled:opacity-40"
        :disabled="!actor"
        :title="actor ? 'Rösta nej - kandidaten faller bort' : 'Välj dig som rörare i toppen'"
        @click="emit('vote', actor?.role ?? 'employee', false)"
      >
        Nej - faller bort
      </button>
    </div>

    <p v-if="card.note" class="text-xs leading-relaxed text-ink-300">{{ card.note }}</p>
    <p v-if="card.drop_reason" class="text-xs text-rose-soft">🚫 {{ card.drop_reason }}</p>

    <footer class="flex items-center justify-between gap-2 text-[11px] text-ink-400">
      <button
        type="button"
        class="underline decoration-dotted hover:text-white"
        @click="emit('drop')"
      >
        Bortfall
      </button>
      <button
        v-if="card.email || card.phone"
        type="button"
        class="underline decoration-dotted hover:text-white"
        @click="showContact = !showContact"
      >
        {{ showContact ? 'Dölj kontakt' : 'Visa kontakt' }}
      </button>
    </footer>

    <p v-if="showContact" class="text-xs text-ink-300">
      {{ card.email || 'ingen e-post' }}
      <span v-if="card.phone"> · {{ card.phone }}</span>
    </p>
  </article>
</template>
