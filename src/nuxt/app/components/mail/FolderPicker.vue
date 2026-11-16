<script setup lang="ts">
/**
 * Väljer vilka mappar som ska genomsökas.
 *
 * Mapparna kommer från mailagenten. De rekommenderade är de som normalt
 * innehåller räntebetalningsmejl - Kameo-mapparna plus mappar som raderade
 * mejl hamnar i.
 */
const props = defineProps<{
  folders: readonly string[]
  recommended: readonly string[]
  modelValue: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

const filter = ref('')

/** Mapparna som matchar filtret, rekommenderade först. */
const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const matched = needle
    ? props.folders.filter((folder) => folder.toLowerCase().includes(needle))
    : [...props.folders]

  // Rekommenderade mappar hamnar först, men alla syns.
  const recommended = matched.filter((folder) => props.recommended.includes(folder))
  const rest = matched.filter((folder) => !props.recommended.includes(folder))

  return [...recommended, ...rest]
})

const selected = computed(() => props.modelValue)

function isSelected(folder: string): boolean {
  return selected.value.includes(folder)
}

function isRecommended(folder: string): boolean {
  return props.recommended.includes(folder)
}

function toggle(folder: string) {
  const next = isSelected(folder)
    ? selected.value.filter((candidate) => candidate !== folder)
    : [...selected.value, folder]
  emit('update:modelValue', next)
}

/**
 * Väljer de rekommenderade mapparna som syns.
 *
 * Ersätter valet - det är det som knappen lovar. Med ett filter aktivt gäller
 * det de rekommenderade mapparna under filtret.
 */
function selectRecommended() {
  emit(
    'update:modelValue',
    visible.value.filter((folder) => props.recommended.includes(folder)),
  )
}

/** Lägger till alla mappar som syns. */
function selectAll() {
  emit('update:modelValue', [...new Set([...selected.value, ...visible.value])])
}

/** Avmarkerar allt - tryggast eftersom dolda mappar också ska bort. */
function selectNone() {
  emit('update:modelValue', [])
}

/** Antalet rekommenderade mappar som syns just nu. */
const visibleRecommendedCount = computed(
  () => visible.value.filter((folder) => props.recommended.includes(folder)).length,
)
</script>

<template>
  <div class="rounded-xl border border-white/10 bg-ink-950/40 p-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs font-semibold uppercase tracking-wider text-ink-400">
        Sök i mappar ({{ selected.length }} valda)
      </p>
      <div class="flex flex-wrap gap-1.5">
        <button
          type="button"
          class="rounded-lg border border-white/10 px-2 py-1 text-xs text-ink-300 transition hover:border-brand-500/40 hover:text-brand-400 disabled:opacity-50"
          :disabled="disabled || visibleRecommendedCount === 0"
          @click="selectRecommended"
        >
          Rekommenderade ({{ visibleRecommendedCount }})
        </button>
        <button
          type="button"
          class="rounded-lg border border-white/10 px-2 py-1 text-xs text-ink-300 transition hover:border-brand-500/40 hover:text-brand-400 disabled:opacity-50"
          :disabled="disabled || visible.length === 0"
          @click="selectAll"
        >
          Lägg till synliga ({{ visible.length }})
        </button>
        <button
          type="button"
          class="rounded-lg border border-white/10 px-2 py-1 text-xs text-ink-300 transition hover:border-white/25 hover:text-white disabled:opacity-50"
          :disabled="disabled || selected.length === 0"
          @click="selectNone"
        >
          Ingen
        </button>
      </div>
    </div>

    <input
      v-model="filter"
      type="search"
      placeholder="Filtrera mappar…"
      class="mt-2 w-full rounded-lg border border-white/10 bg-ink-950/60 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none"
    />

    <ul
      v-if="visible.length > 0"
      class="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-ink-950/40 p-1"
    >
      <li v-for="folder in visible" :key="folder">
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-xs text-ink-300 transition hover:bg-white/5"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="isSelected(folder)"
            :disabled="disabled"
            @change="toggle(folder)"
          />
          <span class="min-w-0 break-all">
            {{ folder }}
            <span
              v-if="isRecommended(folder)"
              class="ml-1 rounded bg-brand-500/20 px-1 py-0.5 text-[10px] font-semibold text-brand-400"
            >
              rekommenderad
            </span>
          </span>
        </label>
      </li>
    </ul>

    <p v-else class="mt-2 text-xs text-ink-400">Inga mappar matchar filtret.</p>

    <p v-if="filter.trim() && visible.length > 0" class="mt-2 text-xs text-ink-400">
      Filtret gäller bara listan. Knapparna ovan påverkar de mappar som syns.
    </p>
  </div>
</template>
