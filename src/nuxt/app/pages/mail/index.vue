<script setup lang="ts">
import { useMailEmailProcessing } from '~/composables/useMailEmailProcessing'

const {
  emails, loading, analyzing, error,
  analyses, decisions, decidingUid,
  fetchEmails, analyzeEmails, decideEmail
} = useMailEmailProcessing()

const { current, folders, folder, needsLogin, selectFolder } = useMailAccounts()

useHead({ title: 'Pappa – Mail' })
</script>

<template>
  <div class="mx-auto max-w-5xl px-5 py-10 sm:px-8">
    <header class="mb-8">
      <div class="flex flex-wrap items-center gap-3">
        <span
          class="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-mint-400 text-lg shadow-lg shadow-brand-500/25"
        >
          📬
        </span>
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">MailMaster</h1>
          <p class="text-sm text-ink-400">
            Konto: {{ current?.name ?? '—' }}
          </p>
        </div>
      </div>
    </header>

    <AccountSelector />

    <EmailControls
      :folder="folder"
      :folders="folders"
      :loading="loading"
      :analyzing="analyzing"
      :disabled="needsLogin"
      @update:folder="selectFolder"
      @fetch="fetchEmails"
      @analyze="analyzeEmails"
    />

    <div
      v-if="error"
      class="card mb-5 border-rose-soft/30 p-4 text-sm text-rose-soft"
    >
      ❌ {{ error }}
    </div>

    <EmailList
      v-if="emails.length > 0"
      :emails="emails"
      :folder="folder"
      :analyses="analyses"
      :decisions="decisions"
      :deciding-uid="decidingUid"
      @decide="decideEmail"
    />

    <div v-else-if="!loading && !error" class="card p-12 text-center">
      <p class="text-lg font-semibold text-white">Inga mejl hämtade</p>
      <p class="mt-1 text-sm text-ink-300">Klicka på knappen ovan för att hämta mejl.</p>
    </div>
  </div>
</template>
