/**
 * Server-side-klient för mailagentens HTTP-API.
 *
 * Nuxt använder normalt proxy via /api/mail, men server-routes behöver nå
 * mailagenten direkt (utan extra HTTP-hop genom webbläsaren).
 */

export interface MailAccountSummary {
  name: string
  server: string
  username: string
  defaultFolder: string
}

export interface MailboxEmail {
  uid: number
  subject: string
  from: string
  to: string
  date: string
  folder: string
  body: string
  hasAttachment: boolean
}

function mailApiBase(): string {
  // I Nuxt-servern finns runtimeConfig. I tester (och andra sammanhang utan
  // Nuxt) är den inte tillgänglig, då läses adressen ur miljön.
  try {
    const config = useRuntimeConfig()
    const fromConfig = config?.mailApiBase
    if (fromConfig) {
      return String(fromConfig).replace(/\/+$/, '')
    }
  } catch {
    // useRuntimeConfig finns inte här - gå vidare till miljön.
  }

  return String(process.env.NUXT_MAIL_API_BASE || '').replace(/\/+$/, '')
}

async function mailRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = mailApiBase()
  if (!base) {
    throw new Error('NUXT_MAIL_API_BASE saknas - kan inte nå mailagenten.')
  }

  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  })

  const text = await response.text()

  if (!response.ok) {
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error ?? text
    } catch {
      // Behåll råtexten.
    }
    throw new Error(message || `Mailagenten svarade HTTP ${response.status}.`)
  }

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

/**
 * Kontona som mailagenten loggar in på.
 */
export async function listMailAccounts(): Promise<MailAccountSummary[]> {
  const response = await mailRequest<{ accounts: MailAccountSummary[] }>('/accounts')
  return response?.accounts ?? []
}

/**
 * Mapparna i ett konto.
 */
export async function listMailFolders(account: string): Promise<string[]> {
  const response = await mailRequest<{ folders: string[] }>(
    `/accounts/${encodeURIComponent(account)}/folders`,
  )
  return response?.folders ?? []
}

/**
 * Mejlen i en mapp.
 */
export async function listMailboxEmails(
  account: string,
  folder: string,
  limit = 50,
): Promise<Array<Omit<MailboxEmail, 'body'>>> {
  const response = await mailRequest<{ emails: Array<Omit<MailboxEmail, 'body'>> }>(
    `/accounts/${encodeURIComponent(account)}/folders/${encodeURIComponent(folder)}/emails?limit=${limit}`,
  )
  return response?.emails ?? []
}

/**
 * Ett enskilt mejl med hela brödtexten.
 */
export async function readMailboxEmail(
  account: string,
  folder: string,
  uid: number,
): Promise<MailboxEmail | null> {
  try {
    return await mailRequest<MailboxEmail>(
      `/accounts/${encodeURIComponent(account)}/folders/${encodeURIComponent(folder)}/emails/${uid}`,
    )
  } catch {
    return null
  }
}

/**
 * Arkiverar ett mejl.
 */
export async function archiveMailboxEmail(
  account: string,
  folder: string,
  uid: number,
): Promise<void> {
  await mailRequest(
    `/accounts/${encodeURIComponent(account)}/folders/${encodeURIComponent(folder)}/emails/${uid}/archive`,
    { method: 'POST' },
  )
}
