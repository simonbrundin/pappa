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
  findInterestPaymentByEmail,
  storeInterestPayment,
  type StoredInterestPayment,
} from './kameo-interest-store'
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
  /** Datumet på den Kameo-transaktion beloppet kom ifrån. */
  transactionDate: string
  /** Om beloppet matchade exakt datum eller en närbelägen rad. */
  match: 'exakt' | 'närbelägen'
  /** Utbetalningsbegäranden som redan pågår hos Kameo. */
  openRequests: Array<{
    id: number
    amount: number
    status: string
    destinationBankAccountId: number | null
  }>
  /** En tidigare sparad betalning för samma mejl, om den finns. */
  alreadyStored: StoredInterestPayment | null
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
  /** Id:t i databasen där underlaget sparades. */
  storedId: string | null
}

/**
 * Mappar som kan innehålla räntebetalningsmejl.
 *
 * De flesta Kameo-mejl ligger i en map per lån ("INBOX.Kameo.Gemensamma.Kameo
 * 5041"), men de senaste hamnade i "INBOX.Deleted Messages" - där hamnar
 * mejl som markerats som raderade i webbmejlen. Sökningen tar därför med
 * både Kameo-mapparna och de generella mapparna.
 */
export async function interestFolders(mailAccount: string): Promise<string[]> {
  const folders = await listMailFolders(mailAccount)

  return folders.filter(
    (folder) =>
      folder === 'INBOX' ||
      /kameo/i.test(folder) ||
      /deleted messages|^archive$/i.test(folder),
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
 * En räntebetalning som matchats mot en Kameo-transaktion.
 */
export interface ResolvedInterest {
  amount: number
  /** Datumet på transaktionen som matchades. */
  transactionDate: string
  /** 'exakt' = samma dag, 'närbelägen' = inom några dagar. */
  match: 'exakt' | 'närbelägen'
}

/**
 * Tar fram beloppet ur Kameos transaktionslista.
 *
 * Mejlet innehåller inte beloppet - det måste matchas mot transaktionen med
 * samma datum. Saknas en matchning returneras null, och då ska inget pengar
 * rör sig.
 *
 * Exakt datummatchning används först. Finns ingen sådan tas den närmaste
 * ränterad inom tre dagar, men då märks matchningen som "närbelägen" så att
 * den syns i granskningsvyn.
 */
export async function resolveInterestAmount(
  loanNumber: number,
  emailDate: string,
): Promise<ResolvedInterest | null> {
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
      return { amount, transactionDate: candidate, match: 'exakt' }
    }
  }

  const emailTime = new Date(emailDate).getTime()
  if (Number.isNaN(emailTime)) {
    return null
  }

  const nearby = transactions
    .map((transaction) => ({
      transaction,
      distance: Math.abs(new Date(transaction.date).getTime() - emailTime),
    }))
    .filter((entry) => entry.distance <= 3 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a.distance - b.distance)

  if (nearby.length === 0) {
    return null
  }

  const closest = nearby[0]
  if (!closest) {
    return null
  }

  const matches = nearby.filter((entry) => entry.transaction.date === closest.transaction.date)
  return {
    amount: matches.reduce((sum, entry) => sum + entry.transaction.amount, 0),
    transactionDate: closest.transaction.date,
    match: 'närbelägen',
  }
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

  const resolved = await resolveInterestAmount(loanNumber, email.date ?? '')
  if (!resolved) {
    throw new Error(
      `Beloppet för lån ${loanNumber} den ${(email.date ?? '').slice(0, 10)} hittades inte ` +
        'i Kameos transaktionslista.',
    )
  }
  const amount = resolved.amount

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
  const openRequests = (summaries[0]?.requests ?? []).filter(
    (request) => !/genomf|slutf|avslut|klar/i.test(request.status),
  )

  let blocked: string | null = null
  if (!destinationAccount) {
    blocked = 'Inget utbetalningskonto är registrerat hos Kameo.'
  } else {
    // Redan begärd? Kameo reserverar beloppet så fort en begäran skapas, och
    // "Tillgängligt belopp" sjunker då. En pågående begäran som täcker
    // räntebetalningen betyder att pengarna redan är på väg ut - att betala
    // igen vore dubbelbetaling. Det gäller även när begäran avser flera
    // lån tillsammans (ett samlingsuttag för hela dagens ränta).
    const covering = openRequests.find(
      (request) =>
        request.amount >= amount - 0.01 &&
        request.destinationBankAccountId === destinationAccount.id,
    )
    if (covering) {
      blocked =
        `En utbetalningsbegäran på ${formatInterestAmount(covering.amount)} kr ` +
        `(${covering.status}, #${covering.id}) pågår redan hos Kameo. ` +
        'Räntebetalningen är redan på väg ut och ska inte betalas igen.'
    } else if (availableAmount < amount) {
      blocked =
        `Tillgängligt belopp hos Kameo (${formatInterestAmount(availableAmount)} kr) ` +
        `räcker inte för räntebetalningen (${formatInterestAmount(amount)} kr).`
    }
  }

  // Redan sparad? Då är betalningen hanterad och ska inte köras igen.
  // Finns ingen databas (t.ex. i test) hoppas kontrollen över.
  let alreadyStored: StoredInterestPayment | null = null
  try {
    alreadyStored = await findInterestPaymentByEmail(mailAccount, folder, uid)
  } catch (error) {
    console.error('[kameo] Kunde inte läsa sparade betalningar:', error)
  }
  if (alreadyStored && !blocked) {
    blocked =
      `Räntebetalningen är redan sparad (${alreadyStored.fileName}, ` +
      `${alreadyStored.createdAt.slice(0, 10)}).`
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
    transactionDate: resolved.transactionDate,
    match: resolved.match,
    openRequests,
    alreadyStored,
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

  // Underlaget sparas så att det finns kvar för bokföring. Om databasen
  // inte är nåbar ska betalningen ändå gå igenom - underlaget finns kvar i
  // PDF:en som returneras.
  let storedId: string | null = null
  try {
    const stored = await storeInterestPayment({
      loanNumber: plan.loanNumber,
      amount: plan.amount,
      currency: plan.destinationAccount?.currency ?? 'SEK',
      classification: plan.classification,
      account: plan.account_8313_8251,
      fileName: plan.fileName,
      mailAccount,
      mailFolder: folder,
      mailUid: uid,
      subject: plan.subject,
      emailDate: plan.date || null,
      kameoWithdrawalId: withdrawalId,
      kameoAccountId: plan.destinationAccount?.id ?? null,
      pdf,
    })
    storedId = stored.id
  } catch (error) {
    console.error('[kameo] Underlaget kunde inte sparas i databasen:', error)
  }

  return {
    ...plan,
    pdfBase64: pdf.toString('base64'),
    withdrawalId,
    withdrawalStatus,
    archived,
    storedId,
  }
}
