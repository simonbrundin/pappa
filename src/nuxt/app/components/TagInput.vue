<script setup lang="ts">
/**
 * Tagginmatning: en textlista med förslag.
 *
 * Används för must-have, nice-to-have, orter och språk. Enter lägger till,
 * Backspace på tomt fält tar bort sista taggen.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[]
    suggestions?: string[]
    placeholder?: string
    id?: string
  }>(),
  { suggestions: () => [], placeholder: 'Skriv och tryck Enter', id: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const draft = ref('')

/** Förslag som matchar det som skrivs, annars de första som inte redan valts. */
const filtered = computed(() => {
  const query = draft.value.trim().toLowerCase()
  const chosen = new Set(props.modelValue)
  const pool = props.suggestions.filter(t => !chosen.has(t))
  if (!query) return pool.slice(0, 12)
  return pool.filter(t => t.toLowerCase().includes(query)).slice(0, 12)
})

function add(tag: string) {
  const value = tag.trim().toLowerCase()
  if (!value || props.modelValue.includes(value)) return
  emit('update:modelValue', [...props.modelValue, value])
  draft.value = ''
}

function remove(tag: string) {
  emit('update:modelValue', props.modelValue.filter(t => t !== tag))
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    if (draft.value.trim()) add(draft.value)
    return
  }
  if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    remove(props.modelValue[props.modelValue.length - 1]!)
  }
}
</script>

<template>
  <div class="rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2">
    <div v-if="modelValue.length" class="mb-2 flex flex-wrap gap-1.5">
      <span
        v-for="tag in modelValue"
        :key="tag"
        class="inline-flex items-center gap-1 rounded-full border border-brand-500/30 bg-brand-500/10 px-2.5 py-0.5 text-xs text-brand-400"
      >
        {{ tag }}
        <button
          type="button"
          class="text-brand-400/70 transition hover:text-white"
          :aria-label="`Ta bort ${tag}`"
          @click="remove(tag)"
        >
          ✕
        </button>
      </span>
    </div>

    <input
      :id="id"
      v-model="draft"
      type="text"
      :placeholder="placeholder"
      list="none"
      class="w-full bg-transparent text-sm text-white placeholder:text-ink-400 focus:outline-none"
      @keydown="onKeydown"
    />

    <ul v-if="filtered.length" class="mt-2 flex flex-wrap gap-1.5">
      <li v-for="tag in filtered" :key="tag">
        <button
          type="button"
          class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-400 transition hover:border-brand-500/40 hover:text-white"
          @click="add(tag)"
        >
          + {{ tag }}
        </button>
      </li>
    </ul>
  </div>
</template>
