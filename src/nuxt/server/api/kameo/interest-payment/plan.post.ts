import { planInterestPayment } from '../../../utils/mail/kameo-interest-flow'

/**
 * Förhandsvisning av en räntebetalning: belopp, konto, filnamn och om något
 * hindrar utbetalningen.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    account?: string
    folder?: string
    uid?: number
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

  try {
    return await planInterestPayment(account, folder, uid)
  } catch (error: any) {
    throw createError({
      statusCode: 502,
      statusMessage: error?.message || 'Kunde inte ta fram räntebetalningen.',
    })
  }
})
