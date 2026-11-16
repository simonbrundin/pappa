/**
 * Lagring av Kameo-ränteutbetalningar i databasen.
 *
 * Varje räntebetalning blir en rad med belopp, bokföringskonto, referens
 * till Kameos uttag och PDF-underlaget. Det gör att en betalning inte kan
 * göras två gånger och att underlaget finns kvar för bokföring.
 */

import { getDb } from '../db'

export interface StoredInterestPayment {
  id: string
  loanNumber: number
  amount: number
  currency: string
  classification: string
  account: string
  fileName: string
  mailAccount: string
  mailFolder: string
  mailUid: number
  subject: string
  emailDate: string | null
  kameoWithdrawalId: number | null
  createdAt: string
}

export interface StoreInterestPaymentInput {
  loanNumber: number
  amount: number
  currency?: string
  classification: string
  account: string
  fileName: string
  mailAccount: string
  mailFolder: string
  mailUid: number
  subject: string
  emailDate?: string | null
  kameoWithdrawalId?: number | null
  kameoAccountId?: number | null
  pdf: Buffer
}

/**
 * Sparar en räntebetalning med sitt underlag.
 *
 * Samma mejl kan inte sparas två gånger - unique-konstanten på
 * (konto, mapp, uid) stoppar det.
 */
export async function storeInterestPayment(
  input: StoreInterestPaymentInput,
): Promise<StoredInterestPayment> {
  const sql = getDb()

  const rows = await sql`
    insert into kameo_interest_payment (
      loan_number, amount, currency, classification, account, file_name,
      mail_account, mail_folder, mail_uid, subject, email_date,
      kameo_withdrawal_id, kameo_account_id, pdf
    ) values (
      ${input.loanNumber},
      ${input.amount},
      ${input.currency ?? 'SEK'},
      ${input.classification},
      ${input.account},
      ${input.fileName},
      ${input.mailAccount},
      ${input.mailFolder},
      ${input.mailUid},
      ${input.subject},
      ${input.emailDate ?? null},
      ${input.kameoWithdrawalId ?? null},
      ${input.kameoAccountId ?? null},
      ${input.pdf}
    )
    on conflict (mail_account, mail_folder, mail_uid) do update set
      amount = excluded.amount,
      kameo_withdrawal_id = excluded.kameo_withdrawal_id,
      pdf = excluded.pdf
    returning id, loan_number, amount, currency, classification, account,
              file_name, mail_account, mail_folder, mail_uid, subject,
              email_date, kameo_withdrawal_id, created_at
  `

  const row = rows[0]
  if (!row) {
    throw new Error('Räntebetalningen kunde inte sparas.')
  }

  return mapRow(row)
}

/**
 * Alla sparade ränteutbetalningar, nyast först.
 */
export async function listInterestPayments(limit = 100): Promise<StoredInterestPayment[]> {
  const sql = getDb()
  const rows = await sql`
    select id, loan_number, amount, currency, classification, account,
           file_name, mail_account, mail_folder, mail_uid, subject,
           email_date, kameo_withdrawal_id, created_at
    from kameo_interest_payment
    order by created_at desc
    limit ${limit}
  `

  return rows.map(mapRow)
}

/**
 * Finns det redan en sparad betalning för det här mejlet?
 */
export async function findInterestPaymentByEmail(
  mailAccount: string,
  mailFolder: string,
  mailUid: number,
): Promise<StoredInterestPayment | null> {
  const sql = getDb()
  const rows = await sql`
    select id, loan_number, amount, currency, classification, account,
           file_name, mail_account, mail_folder, mail_uid, subject,
           email_date, kameo_withdrawal_id, created_at
    from kameo_interest_payment
    where mail_account = ${mailAccount}
      and mail_folder = ${mailFolder}
      and mail_uid = ${mailUid}
    limit 1
  `

  const row = rows[0]
  return row ? mapRow(row) : null
}

function mapRow(row: any): StoredInterestPayment {
  return {
    id: String(row.id),
    loanNumber: Number(row.loan_number),
    amount: Number(row.amount),
    currency: String(row.currency ?? 'SEK'),
    classification: String(row.classification),
    account: String(row.account),
    fileName: String(row.file_name),
    mailAccount: String(row.mail_account),
    mailFolder: String(row.mail_folder),
    mailUid: Number(row.mail_uid),
    subject: String(row.subject),
    emailDate: row.email_date ? new Date(row.email_date).toISOString() : null,
    kameoWithdrawalId: row.kameo_withdrawal_id ? Number(row.kameo_withdrawal_id) : null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}
