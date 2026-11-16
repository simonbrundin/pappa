<script setup lang="ts">
/**
 * Kameo ränteutbetalningar.
 *
 * Flödet:
 *   1. Hitta räntebetalningsmejlet i inkorgen
 *   2. Klassificera lånet (kort/lång) - kontot 8313 resp. 8251
 *   3. Spara mejlet som PDF med filnamnet
 *      "Kameo - 5122 - Ränteutbetalning - 12,2 kr - 8313.pdf"
 *   4. Skicka samma belopp till Företagskonto
 *   5. Arkivera mejlet
 *
 * Steg 4 och 5 görs först när bekräftelse ges, så att inga pengar rör sig
 * innan beloppet har kontrollerats.
 */
useHead({ title: 'Kameo ränteutbetalningar' })

interface FoundEmail {
  folder: string
  uid: number
  subject: string
  from: string
  date: string
  loanNumber: number | null
}

interface Plan {
  account: string
  folder: string
  uid: number
  subject: string
  from: string
  date: string
  loanNumber: number
  amount: number
  amountFormatted: string
  classification: string
  account_8313_8251: string
  fileName: string
  destinationAccount: {
    id: number
    accountName: string
    bankName: string
    bankAccountNumber: string
    iban: string | null
  } | null
  availableAmount: number
  blocked: string | null
}

const config = useRuntimeConfig()
const { accounts, currentAccount, loadAccounts } = useMailAccounts()

const mailAccount = ref(String(config.public.mailDefaultAccount || ''))

const searching = ref(false)
const searchError = ref<string | null>(null)
const emails = ref<FoundEmail[]>([])

const planning = ref(false)
const plan = ref<Plan | null>(null)
const planError = ref<string | null>(null)

interface ExecuteResult {
  fileName: string
  pdfBase64: string
  withdrawalId: number | null
  withdrawalStatus: string
  archived: boolean
}

const executing = ref(false)
const result = ref<ExecuteResult | null>(null)
const executeError = ref<string | null>(null)

const confirmed = ref(false)

onMounted(async () => {
  await loadAccounts()
  if (!mailAccount.value) {
    mailAccount.value = accounts.value[0]?.name ?? currentAccount.value ?? ''
  }
})

function formatDate(value: string): string {
  if (!value) return '–'
  return new Date(value).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function classificationLabel(value: string): string {
  if (value === 'kortsiktig') return 'Kortsiktig'
  if (value === 'langsiktig') return 'Långsiktig'
  return 'Okänd'
}

async function search() {
  if (!mailAccount.value) return
  searching.value = true
  searchError.value = null
  plan.value = null
  result.value = null
  confirmed.value = false

  try {
    const res = await $fetch<{ emails: FoundEmail[] }>('/api/kameo/interest-emails', {
      method: 'POST',
      body: { account: mailAccount.value },
    })
    emails.value = res.emails ?? []
    if (emails.value.length === 0) {
      searchError.value = 'Inga räntebetalningsmejl hittades.'
    }
  } catch (e: any) {
    searchError.value = e?.data?.statusMessage || e?.message || 'Kunde inte genomsöka e-posten.'
  } finally {
    searching.value = false
  }
}

async function loadPlan(email: FoundEmail) {
  planning.value = true
  planError.value = null
  plan.value = null
  result.value = null
  confirmed.value = false

  try {
    plan.value = await $fetch<Plan>('/api/kameo/interest-payment/plan', {
      method: 'POST',
      body: { account: mailAccount.value, folder: email.folder, uid: email.uid },
    })
  } catch (e: any) {
    planError.value = e?.data?.statusMessage || e?.message || 'Kunde inte ta fram räntebetalningen.'
  } finally {
    planning.value = false
  }
}

async function execute() {
  if (!plan.value || !confirmed.value) return
  executing.value = true
  executeError.value = null

  try {
    result.value = await $fetch<ExecuteResult>('/api/kameo/interest-payment/execute', {
      method: 'POST',
      body: {
        account: mailAccount.value,
        folder: plan.value.folder,
        uid: plan.value.uid,
        confirm: true,
        expectLoanNumber: plan.value.loanNumber,
        expectAmount: plan.value.amount,
      },
    })
    // Uppdatera listan så att det behandlade mejlet inte visas som väntande.
    emails.value = emails.value.filter(
      (email) => !(email.folder === plan.value?.folder && email.uid === plan.value?.uid),
    )
  } catch (e: any) {
    executeError.value = e?.data?.statusMessage || e?.message || 'Räntebetalningen kunde inte göras.'
  } finally {
    executing.value = false
  }
}

/** Laddar ner PDF:en med det bestämda filnamnet. */
function downloadPdf() {
  if (!result.value) return
  const binary = atob(result.value.pdfBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result.value.fileName
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight text-white">
        <span class="mr-2">💸</span>Kameo ränteutbetalningar
      </h1>
      <p class="mt-1 text-sm text-ink-400">
        Hitta räntebetalningsmejlet, klassificera lånet, spara underlaget som PDF och skicka
        beloppet till Företagskonto.
      </p>
    </header>

    <section class="card mb-6 p-4">
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-56">
          <label
            class="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-400"
            for="interest-account"
          >
            Mailkonto
          </label>
          <select
            id="interest-account"
            v-model="mailAccount"
            class="w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
          >
            <option v-for="account in accounts" :key="account.name" :value="account.name">
              {{ account.name }}
            </option>
          </select>
        </div>

        <button
          type="button"
          class="rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="searching || !mailAccount"
          @click="search"
        >
          {{ searching ? 'Söker…' : 'Hitta räntebetalningsmejl' }}
        </button>
      </div>
    </section>

    <p v-if="searchError" class="mb-4 rounded-xl border border-rose-soft/30 bg-rose-soft/10 px-4 py-3 text-sm text-rose-soft">
      {{ searchError }}
    </p>

    <section v-if="emails.length > 0" class="mb-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-ink-400">
        Hittade räntebetalningsmejl ({{ emails.length }})
      </h2>
      <ul class="space-y-2">
        <li
          v-for="email in emails"
          :key="`${email.folder}:${email.uid}`"
          class="card flex flex-wrap items-center justify-between gap-3 p-3"
        >
          <div class="min-w-0">
            <p class="truncate font-medium text-ink-100">{{ email.subject }}</p>
            <p class="mt-0.5 truncate text-xs text-ink-400">
              {{ formatDate(email.date) }} · {{ email.folder }}
            </p>
          </div>
          <button
            type="button"
            class="rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-1.5 text-sm font-semibold text-brand-400 transition hover:bg-brand-500/20"
            @click="loadPlan(email)"
          >
            Hantera
          </button>
        </li>
      </ul>
    </section>

    <p v-if="planning" class="mb-4 text-sm text-ink-400">Hämtar uppgifter från Kameo…</p>

    <p
      v-if="planError"
      class="mb-4 rounded-xl border border-rose-soft/30 bg-rose-soft/10 px-4 py-3 text-sm text-rose-soft"
    >
      {{ planError }}
    </p>

    <section v-if="plan" class="card mb-6 p-5">
      <h2 class="mb-4 text-lg font-semibold text-white">Räntebetalning</h2>

      <dl class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Lånenummer</dt>
          <dd class="mt-0.5 text-lg font-semibold text-white">{{ plan.loanNumber }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Belopp</dt>
          <dd class="mt-0.5 text-lg font-semibold text-mint-400">{{ plan.amountFormatted }} kr</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Konto</dt>
          <dd class="mt-0.5 text-lg font-semibold text-white">{{ plan.account_8313_8251 }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Klassificering</dt>
          <dd class="mt-0.5 text-sm text-ink-100">
            {{ classificationLabel(plan.classification) }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Tillgängligt hos Kameo</dt>
          <dd class="mt-0.5 text-sm text-ink-100">{{ plan.availableAmount }} kr</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wider text-ink-400">Utbetalningskonto</dt>
          <dd class="mt-0.5 text-sm text-ink-100">
            {{ plan.destinationAccount?.accountName ?? '–' }}
            <span v-if="plan.destinationAccount" class="block text-xs text-ink-400">
              {{ plan.destinationAccount.bankName }}
            </span>
          </dd>
        </div>
      </dl>

      <p class="mt-4 rounded-xl border border-white/8 bg-ink-950/60 px-3 py-2 font-mono text-xs text-ink-300">
        {{ plan.fileName }}
      </p>

      <p
        v-if="plan.blocked"
        class="mt-4 rounded-xl border border-amber-soft/30 bg-amber-soft/10 px-4 py-3 text-sm text-amber-soft"
      >
        {{ plan.blocked }}
      </p>

      <label class="mt-5 flex items-start gap-2 text-sm text-ink-300">
        <input v-model="confirmed" type="checkbox" class="mt-1" />
        <span>
          Jag har kontrollerat beloppet och vill skicka
          <strong class="text-white">{{ plan.amountFormatted }} kr</strong> till
          {{ plan.destinationAccount?.accountName ?? 'Företagskonto' }} samt arkivera mejlet.
        </span>
      </label>

      <div class="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          class="rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!confirmed || executing || !!plan.blocked"
          @click="execute"
        >
          {{ executing ? 'Utför…' : 'Utför utbetalning' }}
        </button>
      </div>

      <p
        v-if="executeError"
        class="mt-4 rounded-xl border border-rose-soft/30 bg-rose-soft/10 px-4 py-3 text-sm text-rose-soft"
      >
        {{ executeError }}
      </p>
    </section>

    <section v-if="result" class="card p-5">
      <h2 class="mb-3 text-lg font-semibold text-mint-400">Klart</h2>
      <ul class="space-y-1 text-sm text-ink-300">
        <li>PDF: {{ result.fileName }}</li>
        <li>
          Uttag:
          {{ result.withdrawalId ? `#${result.withdrawalId}` : 'skapades' }}
          ({{ result.withdrawalStatus }})
        </li>
        <li>Mejlet arkiverat: {{ result.archived ? 'ja' : 'nej' }}</li>
      </ul>
      <button
        type="button"
        class="mt-4 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:brightness-110"
        @click="downloadPdf"
      >
        Ladda ner PDF
      </button>
    </section>
  </div>
</template>
