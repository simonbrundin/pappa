<script setup lang="ts">
const {
  accounts,
  currentAccount,
  current,
  folders,
  loadingAccounts,
  accountError,
  loginState,
  loginChallenge,
  loginMessage,
  needsLogin,
  loadAccounts,
  selectAccount,
  startLogin,
} = useMailAccounts()

const emit = defineEmits<{
  (e: 'select', name: string): void
}>()

onMounted(() => {
  loadAccounts()
})

async function onSelect(event: Event) {
  const name = (event.target as HTMLSelectElement).value
  await selectAccount(name)
  emit('select', name)
}
</script>

<template>
  <section class="card mb-5 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <label
        class="text-xs font-semibold uppercase tracking-wider text-ink-400"
        for="account-select"
      >
        Konto
      </label>

      <select
        id="account-select"
        class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 transition focus:border-brand-500 focus:outline-none disabled:opacity-50"
        :value="currentAccount"
        :disabled="loadingAccounts || accounts.length === 0"
        @change="onSelect"
      >
        <option v-for="account in accounts" :key="account.name" :value="account.name">
          {{ account.name }}
        </option>
      </select>

      <span v-if="current" class="chip">
        {{ current.username }}
        <span class="text-ink-400">·</span>
        {{ current.server }}
      </span>

      <div class="ml-auto flex items-center gap-2">
        <span v-if="current?.logged_in" class="chip border-mint-400/30 bg-mint-400/10 text-mint-400">
          ✓ Inloggad
        </span>
        <button
          v-if="needsLogin"
          type="button"
          class="rounded-xl bg-gradient-to-br from-amber-soft to-amber-soft/70 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loginState === 'waiting'"
          @click="startLogin"
        >
          {{ loginState === 'waiting' ? '⏳ Väntar på inloggning…' : '🔑 Logga in' }}
        </button>
      </div>
    </div>

    <div
      v-if="loginChallenge && loginState === 'waiting'"
      class="mt-4 rounded-xl border border-brand-500/30 bg-brand-500/10 p-4 text-center"
    >
      <p class="text-sm text-ink-300">
        Öppna
        <a
          :href="loginChallenge.verification_uri"
          target="_blank"
          rel="noopener"
          class="text-brand-400 underline decoration-dotted hover:text-white"
        >
          {{ loginChallenge.verification_uri }}
        </a>
        och mata in koden:
      </p>
      <code class="mt-3 inline-block rounded-lg border border-white/10 bg-ink-950 px-4 py-2 text-xl tracking-[0.3em] text-white">
        {{ loginChallenge.user_code }}
      </code>
    </div>

    <p v-if="loginMessage" class="mt-3 text-sm text-amber-soft">{{ loginMessage }}</p>
    <p v-if="accountError" class="mt-3 text-sm text-rose-soft">{{ accountError }}</p>
  </section>
</template>
