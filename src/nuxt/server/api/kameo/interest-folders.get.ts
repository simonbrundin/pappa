import { interestFolders } from '../../utils/mail/kameo-interest-flow'
import { listMailFolders } from '../../utils/mail/mail-agent'

/**
 * Mapparna i ett mailkonto, med de som rekommenderas för räntebetalningar.
 *
 * UI:t använder detta för att låta användaren välja exakt vilka mappar som
 * ska genomsökas. `recommended` är de mappar som normalt innehåller
 * räntebetalningsmejl - Kameo-mapparna plus mappar som raderade mejl hamnar i.
 */
export default defineEventHandler(async (event) => {
  const account = String(getQuery(event).account ?? '').trim()
  if (!account) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Ange vilket mailkonto som ska genomsökas.',
    })
  }

  try {
    const folders = await listMailFolders(account)
    const recommended = await interestFolders(account)

    return {
      account,
      folders,
      recommended: recommended.filter((folder) => folders.includes(folder)),
    }
  } catch (error: any) {
    throw createError({
      statusCode: 502,
      statusMessage: error?.message || 'Kunde inte lista mapparna.',
    })
  }
})
