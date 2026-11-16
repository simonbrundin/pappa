/**
 * Logik för Kameo-ränteutbetalningar.
 *
 * Flödet är:
 *   1. Hitta räntebetalningsmejlet i inkorgen
 *   2. Klassificera lånet (kort/lång) utifrån lånets löptid
 *   3. Spara mejlet som PDF med ett deterministiskt filnamn
 *   4. Skicka samma belopp till Företagskonto
 *   5. Arkivera mejlet
 *
 * Här ligger de rena delarna - filnamn, belopp, kategorier - utan I/O så att
 * de går att enhetstesta.
 */

/**
 * Kontot som räntebetalningen bokförs på.
 *
 *   - 8313 = kortsiktig
 *   - 8251 = långsiktig
 */
export const INTEREST_ACCOUNT_SHORT = '8313'
export const INTEREST_ACCOUNT_LONG = '8251'

export type InterestClassification = 'kortsiktig' | 'langsiktig'

/**
 * Kontot som räntebetalningen ska bokföras på, givet lånets klassificering.
 */
export function interestAccount(classification: InterestClassification): string {
  return classification === 'kortsiktig' ? INTEREST_ACCOUNT_SHORT : INTEREST_ACCOUNT_LONG
}

/**
 * Formaterar ett belopp på svkt sätt: 12.2 -> "12,2", 12.25 -> "12,25".
 *
 * Avrundningen görs till två decimaler eftersom Kameo redovisar belopp med
 * fyra decimaler ("11.6700").
 */
export function formatInterestAmount(amount: number): string {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100
  return String(rounded).replace('.', ',')
}

/**
 * Filnamnet för PDF:en av ett räntebetalningsmejl.
 *
 * Format: "Kameo - 5122 - Ränteutbetalning - 12,2 kr - 8313.pdf"
 */
export function interestFileName(
  loanNumber: number | string,
  amount: number,
  classification: InterestClassification,
): string {
  const loan = String(loanNumber).trim()
  return [
    'Kameo',
    '-',
    loan,
    '-',
    'Ränteutbetalning',
    '-',
    `${formatInterestAmount(amount)} kr`,
    '-',
    `${interestAccount(classification)}.pdf`,
  ].join(' ')
}

/**
 * Lånenumret ur ett mejl. Ämnet ser ut som "Räntebetalning - lån 5133" men
 * varianterna varierar ("Räntebetalning lån #4033 #52972").
 *
 * Returnerar null om inget lånenummer hittas.
 */
export function parseLoanNumber(subject: string, body = ''): number | null {
  const fromSubject = /l[åa]n\s*#?\s*(\d{3,})/i.exec(subject)
  if (fromSubject) {
    return Number(fromSubject[1])
  }

  const fromBody = /l[åa]nenummer:?\s*#?\s*(\d{3,})/i.exec(body)
  if (fromBody) {
    return Number(fromBody[1])
  }

  return null
}

/**
 * Är ämnet ett räntebetalningsmejl från Kameo?
 */
export function isInterestEmail(subject: string, from = ''): boolean {
  if (!/r[äa]ntebetalning/i.test(subject)) {
    return false
  }
  // Mejl från Kameo. Avsändaren kan vara "Kameo <info@kameo.se>".
  return /kameo/i.test(from)
}

/**
 * En räntebetalning i Kameos transaktionslista.
 */
export interface InterestTransaction {
  date: string
  description: string
  amount: number
}

/**
 * Räntetransaktioner ur ett lån, dvs. transaktioner som beskrivs som
 * "Inkomstränta".
 */
export function interestTransactions(
  transactions: Array<{ date?: string; description?: string; amount?: number | string }>,
): InterestTransaction[] {
  return transactions
    .filter((transaction) => /inkomstr[äa]nta/i.test(transaction.description ?? ''))
    .map((transaction) => ({
      date: String(transaction.date ?? ''),
      description: String(transaction.description ?? ''),
      amount: Number(String(transaction.amount ?? '0').replace(',', '.')),
    }))
    .filter((transaction) => Number.isFinite(transaction.amount))
}

/**
 * Räntetransaktionen som hör till ett givet datum (yyyy-mm-dd).
 *
 * Flera räntetransaktioner samma dag summeras, vilket är vad Kameo gör när
 * lån amorteras och räntan betalas ut i ett svep.
 */
export function interestForDate(
  transactions: InterestTransaction[],
  date: string,
): number | null {
  const matching = transactions.filter((transaction) => transaction.date === date)
  if (matching.length === 0) {
    return null
  }
  return matching.reduce((sum, transaction) => sum + transaction.amount, 0)
}

/**
 * Kontot som ska få räntebetalningen, givet lånets klassificering.
 *
 * Kort lån -> 8313, långt lån -> 8251.
 *
 * Ett lån vars klassificering är okänd (varken slutdatum eller löptid känd)
 * bokförs på det korta kontot, vilket är det försiktigaste valet eftersom det
 * då är lättare att flytta beloppet om klassificeringen senare visar sig
 * vara fel.
 */
export function accountForClassification(classification: LoanClassification): string {
  return classification === 'langsiktig' ? INTEREST_ACCOUNT_LONG : INTEREST_ACCOUNT_SHORT
}
