<script setup lang="ts">
import type { Analysis, Decision, Email } from '~/composables/useMailEmailProcessing'

const props = defineProps<{
  emails: Email[]
  folder: string
  analyses: Record<number, Analysis>
  decisions: Record<number, Decision>
  decidingUid: number | null
}>()

const emit = defineEmits<{
  (e: 'decide', uid: number, decision: 'approve' | 'deny'): void
}>()

function analysisFor(uid: number): Analysis | undefined {
  return props.analyses[uid]
}

function decisionFor(uid: number): Decision | undefined {
  return props.decisions[uid]
}

/** Första bokstaven i avsändarens namn - används som avatar. */
function initial(email: Email): string {
  const name = ((email.from ?? '').split('<')[0] ?? '').trim()
  return (name.charAt(0) || '?').toUpperCase()
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs uppercase tracking-wider text-ink-400">
      {{ emails.length }} mejl i {{ folder }}
    </p>

    <article
      v-for="email in emails"
      :key="email.uid"
      class="card flex flex-col gap-4 p-4 transition hover:border-brand-500/40 sm:flex-row sm:items-start"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-start gap-3">
          <span
            class="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-500/30 to-mint-400/20 text-sm font-bold text-brand-400"
          >
            {{ initial(email) }}
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span class="truncate text-sm font-semibold text-white">{{ email.from }}</span>
              <span class="shrink-0 text-xs text-ink-400">{{ email.date }}</span>
            </div>
            <p class="mt-0.5 truncate text-sm text-ink-100">{{ email.subject }}</p>
          </div>

          <span
            v-if="email.has_attachment"
            class="chip shrink-0 border-brand-500/30 bg-brand-500/10 text-brand-400"
          >
            📎 Bilaga
          </span>
        </div>

        <template v-if="analysisFor(email.uid)">
          <p class="mt-3 text-sm leading-relaxed text-ink-300">
            {{ analysisFor(email.uid)!.description }}
          </p>

          <div class="mt-3 rounded-xl border border-white/8 bg-ink-950/40 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-bold uppercase tracking-wider text-ink-300">
                Rekommenderade åtgärder
              </span>
              <span
                v-if="analysisFor(email.uid)!.rule"
                class="chip border-brand-500/40 bg-brand-500/15 text-brand-400"
              >
                {{ analysisFor(email.uid)!.rule }}
              </span>
              <span class="ml-auto text-xs text-ink-400">
                {{ analysisFor(email.uid)!.confidence }}
              </span>
            </div>

            <ul
              v-if="analysisFor(email.uid)!.actions.length > 0"
              class="mt-2 space-y-1"
            >
              <li
                v-for="action in analysisFor(email.uid)!.actions"
                :key="action.type"
                class="relative pl-4 text-sm text-ink-100 before:absolute before:left-0 before:text-brand-400 before:content-['▸']"
              >
                {{ action.description }}
              </li>
            </ul>
            <p v-else class="mt-2 text-sm text-ink-400">Inga åtgärder föreslagna.</p>

            <p
              v-if="analysisFor(email.uid)!.motivation"
              class="mt-2 border-t border-white/8 pt-2 text-xs italic leading-relaxed text-ink-400"
            >
              {{ analysisFor(email.uid)!.motivation }}
            </p>

            <p
              v-if="analysisFor(email.uid)!.error"
              class="mt-2 text-xs text-rose-soft"
            >
              ⚠️ {{ analysisFor(email.uid)!.error }}
            </p>
          </div>
        </template>
      </div>

      <div
        v-if="analysisFor(email.uid)"
        class="flex shrink-0 items-center gap-2 sm:w-40 sm:flex-col sm:items-stretch"
      >
        <button
          type="button"
          class="flex-1 rounded-xl bg-gradient-to-br from-mint-400 to-mint-400/70 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="decidingUid !== null || decisionFor(email.uid)?.state === 'approved' || decisionFor(email.uid)?.state === 'denied'"
          @click="emit('decide', email.uid, 'approve')"
        >
          ✓ OK
        </button>
        <button
          type="button"
          class="flex-1 rounded-xl bg-gradient-to-br from-rose-soft to-rose-soft/70 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="decidingUid !== null || decisionFor(email.uid)?.state === 'approved' || decisionFor(email.uid)?.state === 'denied'"
          @click="emit('decide', email.uid, 'deny')"
        >
          ✕ Neka
        </button>

        <div
          v-if="decisionFor(email.uid)"
          class="text-center text-xs leading-tight sm:mt-1"
          :class="{
            'text-mint-400': decisionFor(email.uid)!.state === 'approved',
            'text-ink-400': decisionFor(email.uid)!.state === 'denied',
            'text-rose-soft': decisionFor(email.uid)!.state === 'error',
          }"
        >
          <template v-if="decisionFor(email.uid)!.state === 'approved'">✅ Godkänd</template>
          <template v-else-if="decisionFor(email.uid)!.state === 'denied'">🚫 Avböjd</template>
          <template v-else-if="decisionFor(email.uid)!.state === 'error'">
            ❌ {{ decisionFor(email.uid)!.message }}
          </template>
        </div>
      </div>
    </article>
  </div>
</template>
