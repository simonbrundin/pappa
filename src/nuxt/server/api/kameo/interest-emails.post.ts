import {
  findInterestEmails,
  planInterestPayment,
} from '../../utils/mail/kameo-interest-flow'

/**
 * Hittar räntebetalningsmejl i mailagentens mappar.
 *
 * Svaret innehåller de mejl som hittades, utan att något utförs.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ account?: string; folders?: string[] }>(event).catch(
    () => ({}) as any,
  )

  const account = typeof body?.account === 'string' ? body.account : ''
  if (!account) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Ange vilket mailkonto som ska genomsökas.',
    })
  }

  try {
    const emails = await findInterestEmails(
      account,
      Array.isArray(body?.folders) ? { folders: body.folders } : {},
    )
    return { account, emails }
  } catch (error: any) {
    throw createError({
      statusCode: 502,
      statusMessage: error?.message || 'Kunde inte genomsöka e-posten.',
    })
  }
})
