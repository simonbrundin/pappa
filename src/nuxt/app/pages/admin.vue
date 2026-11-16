<script setup lang="ts">
/**
 * Admin - inloggning och sessionsstatus.
 *
 * Här matas admin-lösenordet in. Det skickas till servern i
 * requestkroppen och byts mot en httpOnly-cookie, så lösenordet
 * lagras aldrig i webbläsaren.
 */
const { authenticated, refresh, login, logout } = useAdminSession()
const password = ref('')
const status = ref<'idle' | 'pending' | 'ok' | 'error'>('idle')
const errorText = ref('')

onMounted(async () => {
  await refresh()
})

async function handleLogin() {
  if (!password.value) return
  status.value = 'pending'
  errorText.value = ''
  try {
    await login(password.value)
    // Töm fältet direkt - lösenordet ska inte ligga kvar i DOM:en.
    password.value = ''
    status.value = 'ok'
  } catch (err: unknown) {
    const e = err as { data?: { message?: string }; statusMessage?: string }
    status.value = 'error'
    errorText.value = e.data?.message ?? e.statusMessage ?? 'Kunde inte logga in.'
  }
}

async function handleLogout() {
  await logout()
  status.value = 'idle'
}

useHead({ title: 'Pappa – Admin' })
</script>

<template>
  <div class="mx-auto max-w-lg px-5 py-16">
    <h1 class="text-2xl font-semibold text-white">Admin</h1>

    <!-- Redan inloggad -->
    <div v-if="authenticated" class="mt-6 card p-5">
      <p class="text-sm text-mint-400">Du är inloggad som admin.</p>
      <p class="mt-2 text-xs leading-relaxed text-ink-400">
        Skrivning mot databasen (slå ihop dubbletter, spara kravprofiler,
        ändra pipeline) är tillåten i den här webbläsaren.
      </p>
      <button
        type="button"
        class="mt-4 rounded-xl border border-white/10 px-3 py-2 text-sm text-ink-100 transition hover:border-brand-500/50"
        @click="handleLogout"
      >
        Logga ut
      </button>

      <NuxtLink
        to="/kandidater"
        class="mt-2 block w-full rounded-xl bg-brand-500 px-3 py-2 text-center text-sm font-medium text-white transition hover:bg-brand-600"
      >
        Till kandidater
      </NuxtLink>
    </div>

    <!-- Inloggningsformulär -->
    <form v-else class="mt-6 card p-5" @submit.prevent="handleLogin">
      <label class="block">
        <span class="mb-1 block text-xs uppercase tracking-wide text-ink-400">
          Admin-lösenord
        </span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="Lösenord"
          class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
        />
      </label>

      <button
        type="submit"
        class="mt-4 w-full rounded-xl bg-brand-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
        :disabled="status === 'pending' || !password"
      >
        {{ status === 'pending' ? 'Loggar in…' : 'Logga in' }}
      </button>

      <p v-if="status === 'error'" class="mt-3 text-sm text-rose-soft">{{ errorText }}</p>

      <p class="mt-4 text-xs leading-relaxed text-ink-400">
        Lösenordet sätts i appens miljö (<code class="text-ink-300">NUXT_ADMIN_TOKEN</code>)
        och ändras med <code class="text-ink-300">./scripts/admin-token.sh init</code>.
        Det lagras aldrig i webbläsaren - servern sätter bara en sessioncookie.
      </p>
    </form>
  </div>
</template>
