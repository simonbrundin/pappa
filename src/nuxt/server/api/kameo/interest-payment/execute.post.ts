import { executeInterestPayment } from '../../../utils/mail/kameo-interest-flow'

/**
 * Utför en räntebetalning: skapar PDF:en, begär uttag till Företagskonto och
 * arkiverar mejlet.
 *
 * `confirm` måste vara true - utan bekräftelse görs ingenting. Parametrarna
 * `expectLoanNumber` och `expectAmount` skyddar mot att fel mejl behandlas.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    account?: string
    folder?: string
    uid?: number
    confirm?: boolean
    expectLoanNumber?: number
    expectAmount?: number
    destinationBankAccountId?: number
    skipWithdrawal?: boolean
    skipArchive?: boolean
  }>(event).catch(() => ({}) as any)

  const account = typeof body?.account === 'string' ? body.account : ''
  const folder = typeof body?.folder === 'string' ? body.folder : ''
  const uid = Number(body?.uid)

  if (!account || !folder || !Number.isFinite(uid)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Ange konto, mapp och mejl-ID (uid).',
    })
  }

  if (body?.confirm !== true) {
    throw createError({
      statusCode: 428,
      statusMessage:
        'Bekräfta utbetalningen med confirm=true - utan bekräftelse görs ingenting.',
    })
  }

  try {
    return await executeInterestPayment(account, folder, uid, {
      expectLoanNumber:
        typeof body?.expectLoanNumber === 'number' ? body.expectLoanNumber : undefined,
      expectAmount: typeof body?.expectAmount === 'number' ? body.expectAmount : undefined,
      destinationBankAccountId:
        typeof body?.destinationBankAccountId === 'number'
          ? body.destinationBankAccountId
          : undefined,
      skipWithdrawal: body?.skipWithdrawal === true,
      skipArchive: body?.skipArchive === true,
    })
  } catch (error: any) {
    throw createError({
      statusCode: 502,
      statusMessage: error?.message || 'Räntebetalningen kunde inte genomföras.',
    })
  }
})
