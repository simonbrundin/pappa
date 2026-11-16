<script setup lang="ts">
/**
 * Standard-layout: sidebar med alla sidor + innehåll.
 *
 * Alla sidor ligger under app/pages och listas här i `sections`.
 * En ny sida ska läggas in här också, annars syns den inte i navigationen.
 */
interface NavItem {
  to: string
  label: string
  icon: string
}

interface NavSection {
  title: string | null
  items: NavItem[]
}

const sections: NavSection[] = [
  {
    title: 'Rekrytering',
    items: [
      { to: '/kandidater', label: 'Kandidater', icon: '👥' },
      { to: '/pipeline', label: 'Pipeline', icon: '🗂️' },
      { to: '/uppdrag', label: 'Uppdrag', icon: '🎯' },
    ],
  },
  {
    title: 'Mail',
    items: [
      { to: '/mail', label: 'Inkorg', icon: '📬' },
      { to: '/mail/rules', label: 'Regler', icon: '📝' },
    ],
  },
  {
    title: null,
    items: [
      { to: '/kameo-utbetalningar', label: 'Kameo utbetalningar', icon: '💸' },
      { to: '/kameo-ranteutbetalningar', label: 'Ränteutbetalningar', icon: '📈' },
      { to: '/admin', label: 'Admin', icon: '🔐' },
    ],
  },
]

const route = useRoute()

/** Sidomenyn är öppen på mobil, stängd på desktop. */
const mobileOpen = ref(false)

/** Stäng menyn när man navigerar (mobil). */
watch(() => route.path, () => {
  mobileOpen.value = false
})

/**
 * Endast den mest specifika träffen markeras aktiv.
 * "/kameo-utbetalningar" är en egen toppnivå i menyn, inte en del av
 * "/mail" - annars skulle både Inkorg och Kameo lysa samtidigt.
 */
const activeTo = computed(() => {
  const path = route.path.replace(/\/+$/, '') || '/kandidater'
  const all = sections.flatMap(section => section.items)
  const match = all
    .filter(item => item.to === '/' ? path === '/' : path === item.to || path.startsWith(`${item.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]
  return match?.to ?? null
})

function isActive(to: string): boolean {
  return activeTo.value === to
}
</script>

<template>
  <div class="min-h-screen">
    <NuxtRouteAnnouncer />

    <!-- Toppbar med menyknapp på mobil -->
    <header
      class="sticky top-0 z-40 flex items-center gap-3 border-b border-white/8 bg-ink-950/90 px-4 py-3 backdrop-blur md:hidden"
    >
      <button
        type="button"
        class="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-ink-300 transition hover:border-brand-500/50 hover:text-white"
        :aria-expanded="mobileOpen"
        aria-label="Växla meny"
        @click="mobileOpen = !mobileOpen"
      >
        ☰
      </button>
      <span class="text-sm font-semibold tracking-tight text-white">Pappa</span>
    </header>

    <div class="md:flex">
      <!-- Sidebar -->
      <aside
        class="z-30 shrink-0 border-r border-white/8 bg-ink-900/60 md:sticky md:top-0 md:h-screen md:w-64"
        :class="mobileOpen ? 'block' : 'hidden md:block'"
      >
        <nav class="flex h-full flex-col gap-6 overflow-y-auto p-4">
          <NuxtLink to="/kandidater" class="flex items-center gap-3 px-2">
            <span
              class="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-mint-400 text-lg font-bold text-ink-950 shadow-lg shadow-brand-500/25"
            >
              P
            </span>
            <span class="text-base font-semibold tracking-tight text-white">Pappa</span>
          </NuxtLink>

          <div v-for="(section, index) in sections" :key="section.title ?? `section-${index}`" class="flex flex-col gap-1">
            <p
              v-if="section.title"
              class="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-400"
            >
              {{ section.title }}
            </p>
            <NuxtLink
              v-for="item in section.items"
              :key="item.to"
              :to="item.to"
              class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition"
              :class="isActive(item.to)
                ? 'bg-brand-500/15 text-white ring-1 ring-brand-500/40'
                : 'text-ink-300 hover:bg-white/5 hover:text-white'"
            >
              <span class="text-base">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </NuxtLink>
          </div>
        </nav>
      </aside>

      <!-- Innehåll -->
      <main class="min-w-0 flex-1">
        <slot />
      </main>
    </div>
  </div>
</template>
