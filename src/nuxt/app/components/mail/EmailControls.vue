<script setup lang="ts">
defineProps<{
  folder: string
  folders: readonly string[]
  loading: boolean
  analyzing: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:folder', value: string): void
  (e: 'fetch'): void
  (e: 'analyze'): void
}>()
</script>

<template>
  <section class="card mb-5 flex flex-wrap items-center gap-3 p-4">
    <label class="sr-only" for="folder-select">Mapp</label>
    <select
      id="folder-select"
      class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 transition focus:border-brand-500 focus:outline-none disabled:opacity-50"
      :value="folder"
      :disabled="disabled || folders.length === 0"
      @change="emit('update:folder', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="f in folders" :key="f" :value="f">{{ f }}</option>
    </select>

    <button
      type="button"
      class="rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="loading || disabled"
      @click="emit('fetch')"
    >
      {{ loading ? '⏳ Laddar…' : '📥 Hämta mejl' }}
    </button>

    <button
      type="button"
      class="rounded-xl bg-gradient-to-br from-amber-soft to-amber-soft/70 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="analyzing || disabled"
      @click="emit('analyze')"
    >
      {{ analyzing ? '🤖 Analyserar…' : '🤖 Processa mejl' }}
    </button>
  </section>
</template>
