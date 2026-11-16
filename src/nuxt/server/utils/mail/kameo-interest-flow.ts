/**
 * Orkestrering av Kameo-ränteutbetalningar.
 *
 * Flödet, steg för steg:
 *
 *   1. Hitta räntebetalningsmejlet (lån-nummer ur ämnet)
 *   2. Klassificera lånet (kort/lång) och välj konto
 *   3. Ta fram beloppet ur Kameos transaktionslista
 *   4. Skapa PDF av mejlet
 *   5. Begär uttag till Företagskonto med samma belopp
 *   6. Arkivera mejlet
 *
 * Varje steg kan köras separat via `executeInterestPayment`, vilket gör att
 * UI:t kan visa en förhandsvisning innan något pengar rör sig.
 */

import {
  createWithdrawalRequest,
  getLoanTransactions,
  getPrimaryAccountNo,
  getWithdrawalAccounts,
  getWithdrawalSummary,
  lookupKameoLoans,
  type KameoWithdrawalAccount,
} from './kameo'
import {
  accountForClassification,
  formatInterestAmount,
  interestFileName,
  interestForDate,
  interestTransactions,
  isInterestEmail,
  parseLoanNumber,
} from './kameo-interest'
import { buildInterestPdf } from './kameo-pdf'
import {
  archiveMailboxEmail,
  listMailFolders,
  listMailboxEmails,
  readMailboxEmail,
} from './mail-agent'

/**
 * Mappen som räntebetalningsmejl hamnar i.
 */
export const INTEREST_FOLDER_PREFIX = 'INBOX.Kameo'

/**
 * Vad som behöver veta om en räntebetalning innan något utförs.
 */
export interface InterestPaymentPlan {
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
  destinationAccount: KameoWithdrawalAccount | null
  availableAmount: number
  /** Sant om något hindrar att utbetalningen kan göras. */
  blocked: string | null
}

/**
 * Resultatet av en genomförd räntebetalning.
 */
export interface InterestPaymentResult extends InterestPaymentPlan {
  pdfBase64: string
  withdrawalId: number | null
  withdrawalStatus: string
  archived: boolean
}

/**
 * Mappar som kan innehålla räntebetalningsmejl.
 */
export async function interestFolders(mailAccount: string): Promise<string[]> {
  const folders = await listMailFolders(mailAccount)
  return folders.filter(
    (folder) => folder.startsWith(INTEREST_FOLDER_PREFIX) || folder === 'INBOX',
  )
}

/**
 * Ett räntebetalningsmejl som hittats i inkorgen.
 */
export interface FoundInterestEmail {
  folder: string
  uid: number
  subject: string
  from: string
  date: string
  loanNumber: number | null
}

/**
 * Söker igenom mapparna efter räntebetalningsmejl.
 */
export async function findInterestEmails(
  mailAccount: string,
  options: { folders?: string[]; limitPerFolder?: number } = {},
): Promise<FoundInterestEmail[]> {
  const folders = options.folders ?? (await interestFolders(mailAccount))
  const limit = options.limitPerFolder ?? 25
  const found: FoundInterestEmail[] = []

  for (const folder of folders) {
    let emails: Array<{ uid: number; subject: string; from: string; date: string }> = []
    try {
      emails = await listMailboxEmails(mailAccount, folder, limit)
    } catch {
      // En mapp som inte går att läsa ska inte stoppa hela sökningen.
      continue
    }

    for (const email of emails) {
      if (!isInterestEmail(email.subject ?? '', email.from ?? '')) {
        continue
      }
      found.push({
        folder,
        uid: email.uid,
        subject: email.subject,
        from: email.from,
        date: email.date,
        loanNumber: parseLoanNumber(email.subject ?? ''),
      })
    }
  }

  return found
}

/**
 * Tar fram beloppet ur Kameos transaktionslista.
 *
 * Mejlet innehåller inte beloppet - det måste matchas mot transaktionen med
 * samma datum. Saknas en matchning returneras null, och då ska inget pengar
 * rör sig.
 */
export async function resolveInterestAmount(
  loanNumber: number,
  emailDate: string,
): Promise<number | null> {
  const transactions = interestTransactions(await getLoanTransactions(loanNumber))
  if (transactions.length === 0) {
    return null
  }

  // Mejlens datum är i UTC, Kameos är i lokal tid (Europe/Stockholm).
  // Jämför därför båda dagarna.
  const candidates = [emailDate.slice(0, 10), toLocalDate(emailDate)]
  for (const candidate of candidates) {
    const amount = interestForDate(transactions, candidate)
    if (amount !== null) {
      return amount
    }
  }

  return null
}

/**
 * Konverterar en ISO-sträng till datum i Europe/Stockholm.
 */
function toLocalDate(date: string): string {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) {
    return date.slice(0, 10)
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(parsed)
    .replace(/[^0-9]/g, '')
    .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
}

/**
 * Bygger en plan för en räntebetalning utan att utföra något.
 */
export async function planInterestPayment(
  mailAccount: string,
  folder: string,
  uid: number,
): Promise<InterestPaymentPlan> {
  const email = await readMailboxEmail(mailAccount, folder, uid)
  if (!email) {
    throw new Error(`Mejlet ${uid} i ${folder} kunde inte läsas.`)
  }

  const loanNumber = parseLoanNumber(email.subject ?? '', email.body ?? '')
  if (!loanNumber) {
    throw new Error('Lånenumret kunde inte hittas i mejlet.')
  }

  const lookup = await lookupKameoLoans(String(loanNumber))
  const loan = lookup.results.find((result) => result.loanNumber === loanNumber)
  if (!loan) {
    throw new Error(`Lån ${loanNumber} hittades inte hos Kameo.`)
  }

  const amount = await resolveInterestAmount(loanNumber, email.date ?? '')
  if (amount === null) {
    throw new Error(
      `Beloppet för lån ${loanNumber} den ${(email.date ?? '').slice(0, 10)} hittades inte ` +
        'i Kameos transaktionslista.',
    )
  }

  const account = accountForClassification(loan.classification)
  const fileName = interestFileName(loanNumber, amount, loan.classification === 'langsiktig' ? 'langsiktig' : 'kortsiktig')

  const withdrawalAccounts = await getWithdrawalAccounts()
  const destinationAccount =
    withdrawalAccounts.find((candidate) => candidate.isMainAccount) ??
    withdrawalAccounts.find((candidate) => /f[öo]retagskonto/i.test(candidate.accountName)) ??
    withdrawalAccounts[0] ??
    null

  const summaries = await getWithdrawalSummary()
  const availableAmount = summaries[0]?.amountAvailable ?? 0

  let blocked: string | null = null
  if (!destinationAccount) {
    blocked = 'Inget utbetalningskonto är registrerat hos Kameo.'
  } else if (availableAmount < amount) {
    blocked =
      `Tillgängligt belopp hos Kameo (${formatInterestAmount(availableAmount)} kr) ` +
      `räcker inte för räntebetalningen (${formatInterestAmount(amount)} kr).`
  }

  return {
    account: mailAccount,
    folder,
    uid,
    subject: email.subject ?? '',
    from: email.from ?? '',
    date: email.date ?? '',
    loanNumber,
    amount,
    amountFormatted: formatInterestAmount(amount),
    classification: loan.classification,
    account_8313_8251: account,
    fileName,
    destinationAccount,
    availableAmount,
    blocked,
  }
}

/**
 * Utför hela flödet: PDF, uttag och arkivering.
 *
 * Parametrarna `expectLoanNumber` och `expectAmount` skyddar mot att fel
 * mejl behandlas - de måste stämma mot det som faktiskt hittades.
 */
export async function executeInterestPayment(
  mailAccount: string,
  folder: string,
  uid: number,
  options: {
    expectLoanNumber?: number
    expectAmount?: number
    destinationBankAccountId?: number
    skipWithdrawal?: boolean
    skipArchive?: boolean
  } = {},
): Promise<InterestPaymentResult> {
  const plan = await planInterestPayment(mailAccount, folder, uid)

  if (
    options.expectLoanNumber !== undefined &&
    options.expectLoanNumber !== plan.loanNumber
  ) {
    throw new Error(
      `Lån-ID mismatch: förväntade ${options.expectLoanNumber} men mejlet gäller ${plan.loanNumber}.`,
    )
  }

  if (options.expectAmount !== undefined && Math.abs(options.expectAmount - plan.amount) > 0.001) {
    throw new Error(
      `Belopp mismatch: förväntade ${options.expectAmount} men beloppet är ${plan.amount}.`,
    )
  }

  const email = await readMailboxEmail(mailAccount, folder, uid)
  if (!email) {
    throw new Error(`Mejlet ${uid} i ${folder} kunde inte läsas.`)
  }

  const pdf = await buildInterestPdf({
    fileName: plan.fileName,
    subject: plan.subject,
    from: plan.from,
    date: plan.date,
    loanNumber: plan.loanNumber,
    amount: plan.amount,
    account: plan.account_8313_8251,
    body: email.body ?? '',
  })

  let withdrawalId: number | null = null
  let withdrawalStatus = 'skipped'

  if (!options.skipWithdrawal) {
    if (plan.blocked) {
      throw new Error(plan.blocked)
    }

    const destinationId =
      options.destinationBankAccountId ?? plan.destinationAccount?.id ?? null
    if (!destinationId) {
      throw new Error('Inget utbetalningskonto kunde bestämmas.')
    }

    const accountNo = await getPrimaryAccountNo()
    if (!accountNo) {
      throw new Error('Kundkontot hos Kameo kunde inte läsas.')
    }

    const request = await createWithdrawalRequest(plan.amount, destinationId, accountNo)
    withdrawalId = request.id
    withdrawalStatus = request.status
  }

  let archived = false
  if (!options.skipArchive) {
    await archiveMailboxEmail(mailAccount, folder, uid)
    archived = true
  }

  return {
    ...plan,
    pdfBase64: pdf.toString('base64'),
    withdrawalId,
    withdrawalStatus,
    archived,
  }
}
