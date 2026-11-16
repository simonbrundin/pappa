import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Testerar hela flödet med mockad Kameo, mockad mailagent och mockad databas.
 *
 * Målet är att verifiera ordningen (PDF -> uttag -> arkivering -> spara), att
 * beloppet och kontot följer med rätt, och att fel stoppar flödet innan
 * pengar rör sig.
 */

// Databaslagret mockas - testet ska inte röra riktig data.
mock.module('../utils/mail/kameo-interest-store', () => ({
  findInterestPaymentByEmail: async (mailAccount: string, folder: string, uid: number) => {
    const found = storedPayments.find(
      (payment) =>
        payment.mailAccount === mailAccount &&
        payment.mailFolder === folder &&
        payment.mailUid === uid,
    )
    return found ?? null
  },
  storeInterestPayment: async (input: any) => {
    const stored = {
      id: `stored-${storedPayments.length + 1}`,
      loanNumber: input.loanNumber,
      amount: input.amount,
      currency: input.currency ?? 'SEK',
      classification: input.classification,
      account: input.account,
      fileName: input.fileName,
      mailAccount: input.mailAccount,
      mailFolder: input.mailFolder,
      mailUid: input.mailUid,
      subject: input.subject,
      emailDate: input.emailDate ?? null,
      kameoWithdrawalId: input.kameoWithdrawalId ?? null,
      createdAt: new Date().toISOString(),
    }
    storedPayments.push(stored)
    return stored
  },
  listInterestPayments: async () => storedPayments,
}))

const storedPayments: any[] = []

const calls: Array<{ method: string; url: string; body?: unknown }> = []

const loanTransactions = [
  { date: '2026-10-15', description: 'Inkomstränta', amount: '11.67' },
  { date: '2026-11-16', description: 'Inkomstränta', amount: '11.67' },
]

/**
 * Lånen som mocken svarar med. 5041 har 20 månaders löptid och är långsiktigt
 * (konto 8251), 5122 har 6 månaders löptid och är kortsiktigt (konto 8313).
 */
const mockLoans = [
  {
    loan_number: 5041,
    loan_id: 5041,
    loan_name: 'Lingonriset 97 Ekonomisk förening',
    loan_duration_months: 20,
    status: 'ongoing',
    invested_bought: '2000.00',
    remaining_amount: '2000.00',
    transactions: loanTransactions,
  },
  {
    loan_number: 5122,
    loan_id: 5122,
    loan_name: 'Kort lån',
    loan_duration_months: 6,
    status: 'ongoing',
    invested_bought: '1000.00',
    remaining_amount: '1000.00',
    transactions: [
      { date: '2026-11-16', description: 'Inkomstränta', amount: '12.20' },
    ],
  },
]

const state = {
  archived: false,
  createdWithdrawal: null as unknown,
  availableAmount: '100.0000',
  openRequests: [] as Array<{
    id: number
    amount: number
    status: string
    destination_bank_account_id: number
  }>,
  stored: [] as unknown[],
}

const originalFetch = globalThis.fetch

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function kameoHandler(url: string, init?: RequestInit): Response {
  const path = new URL(url).pathname
  const method = init?.method ?? 'GET'

  if (path.endsWith('/authenticate/2fa')) {
    return jsonResponse({ data: { access_token: 'test-token', exp: Math.floor(Date.now() / 1000) + 3600 } })
  }
  if (path.endsWith('/account/transactions-by-loan')) {
    return jsonResponse({ data: mockLoans })
  }
  if (path.endsWith('/account/risk-distribution')) {
    return jsonResponse({ data: { positions: [] } })
  }
  if (path.endsWith('/account/upcoming-repayments')) {
    return jsonResponse({ data: { upcoming_repayments: [] } })
  }
  if (path.endsWith('/me/customer-accounts')) {
    return jsonResponse([{ account_no: 1477074, is_primary: true }])
  }
  if (path.endsWith('/me')) {
    return jsonResponse({ data: { organization_name: 'Michael Brundin AB', email: 'michael@brundins.se' } })
  }
  if (path.endsWith('/customer/withdrawal-accounts')) {
    return jsonResponse({
      data: [
        {
          id: 39973,
          account_name: '1932 - Företagskonto',
          account_holder_name: 'Michael Brundin',
          bank_name: 'Svea Bank',
          bank_account_number: '3061599',
          currency: 'SEK',
          bank_iban: 'SE7996600000096603061599',
          is_main_account: 1,
        },
      ],
    })
  }
  if (path.endsWith('/customer/withdrawal-requests/summary')) {
    return jsonResponse({
      data: {
        customer_accounts: [
          {
            account_no: '1477074',
            amount_available: state.availableAmount,
            currency_code: 'SEK',
            withdrawal_requests: state.openRequests,
          },
        ],
        bank_details: [],
      },
    })
  }
  if (path.endsWith('/customer/withdrawal-requests/create')) {
    state.createdWithdrawal = JSON.parse(String(init?.body ?? '{}'))
    return jsonResponse({
      data: {
        id: 250527,
        amount: (state.createdWithdrawal as any).amount,
        currency_code: 'SEK',
        status_info: { description: 'Uttagsbegäran behandlas' },
        destination_bank_account_id: 39973,
      },
    })
  }

  return jsonResponse({ error: `otestad route: ${method} ${path}` }, 404)
}

function mailHandler(url: string, init?: RequestInit): Response {
  const path = new URL(url).pathname
  const method = init?.method ?? 'GET'

  if (path.includes('/emails/') && path.endsWith('/archive')) {
    state.archived = true
    return jsonResponse({ uid: 1, archived: true })
  }
  if (path.includes('/emails/')) {
    return jsonResponse({
      uid: 1,
      subject: 'Räntebetalning - lån 5041',
      from: 'Kameo <info@kameo.se>',
      to: 'michael@brundins.se',
      date: '2026-11-16T09:35:11Z',
      folder: 'INBOX',
      body: 'Du har tagit emot en räntebetalning för ett lån via Kameo. Lånenummer: 5041',
      has_attachment: false,
    })
  }
  if (path.endsWith('/folders')) {
    return jsonResponse({
      folders: [
        'INBOX',
        'INBOX.Deleted Messages',
        'INBOX.Kameo',
        'INBOX.Kameo.Lån 5041',
        'INBOX.Archive',
        'INBOX.Tessin',
      ],
    })
  }
  if (path.endsWith('/emails')) {
    return jsonResponse({
      emails: [
        {
          uid: 1,
          subject: 'Räntebetalning - lån 5041',
          from: 'Kameo <info@kameo.se>',
          date: '2026-11-16T09:35:11Z',
          folder: 'INBOX',
          has_attachment: false,
        },
      ],
    })
  }

  return jsonResponse({ error: `otestad mailroute: ${method} ${path}` }, 404)
}

beforeEach(() => {
  calls.length = 0
  state.archived = false
  state.createdWithdrawal = null
  state.availableAmount = '100.0000'
  state.openRequests = []
  state.stored = []
  storedPayments.length = 0

  // Kameo-uppgifterna sätts i miljön så att inloggningen inte går till
  // 1Password under testet.
  process.env.KAMEO_EMAIL = 'michael@brundins.se'
  process.env.KAMEO_PASSWORD = 'hemligt'
  process.env.KAMEO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
  process.env.NUXT_MAIL_API_BASE = 'http://mailagent.test/api/v1'

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })

    if (url.includes('api.kameo.se')) {
      return kameoHandler(url, init)
    }
    if (url.includes('/api/v1/')) {
      return mailHandler(url, init)
    }
    return originalFetch(input as any, init)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.KAMEO_EMAIL
  delete process.env.KAMEO_PASSWORD
  delete process.env.KAMEO_TOTP_SECRET
  delete process.env.NUXT_MAIL_API_BASE
})

describe('executeInterestPayment', () => {
  test('gör PDF, uttag och arkivering i rätt ordning', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    const result = await executeInterestPayment('Michael Brundins', 'INBOX', 1)

    expect(result.loanNumber).toBe(5041)
    expect(result.amount).toBe(11.67)
    expect(result.amountFormatted).toBe('11,67')
    // 5041 har 20 månaders löptid och är långsiktigt -> konto 8251.
    expect(result.classification).toBe('langsiktig')
    expect(result.fileName).toBe('Kameo - 5041 - Ränteutbetalning - 11,67 kr - 8251.pdf')
    expect(result.archived).toBe(true)
    expect(result.withdrawalId).toBe(250527)
    expect(result.pdfBase64.length).toBeGreaterThan(100)
    expect(result.storedId).toBe('stored-1')

    // Underlaget sparas med rätt belopp, konto och filnamn.
    expect(storedPayments[0]).toMatchObject({
      loanNumber: 5041,
      amount: 11.67,
      account: '8251',
      fileName: 'Kameo - 5041 - Ränteutbetalning - 11,67 kr - 8251.pdf',
      kameoWithdrawalId: 250527,
    })

    // Utbetalningen ska ha samma belopp som räntebetalningen.
    expect(state.createdWithdrawal).toMatchObject({
      amount: 11.67,
      bank_details_id: 39973,
      account_no: 1477074,
    })

    // Ordningen: uttag före arkivering.
    const createIndex = calls.findIndex((call) => call.url.includes('withdrawal-requests/create'))
    const archiveIndex = calls.findIndex((call) => call.url.includes('/archive'))
    expect(createIndex).toBeGreaterThan(-1)
    expect(archiveIndex).toBeGreaterThan(createIndex)
  })

  test('kort lån bokförs på 8313', async () => {
    const { planInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    const originalHandler = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      if (url.includes('/emails/')) {
        return jsonResponse({
          uid: 2,
          subject: 'Räntebetalning - lån 5122',
          from: 'Kameo <info@kameo.se>',
          to: 'michael@brundins.se',
          date: '2026-11-16T09:35:11Z',
          folder: 'INBOX',
          body: 'Lånenummer: 5122',
          has_attachment: false,
        })
      }
      return originalHandler(input, init)
    }) as typeof fetch

    const plan = await planInterestPayment('Michael Brundins', 'INBOX', 2)

    expect(plan.loanNumber).toBe(5122)
    expect(plan.amount).toBe(12.2)
    expect(plan.classification).toBe('kortsiktig')
    expect(plan.account_8313_8251).toBe('8313')
    expect(plan.fileName).toBe('Kameo - 5122 - Ränteutbetalning - 12,2 kr - 8313.pdf')
  })

  test('avbryter om beloppet inte stämmer', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    await expect(
      executeInterestPayment('Michael Brundins', 'INBOX', 1, { expectAmount: 99.99 }),
    ).rejects.toThrow(/Belopp mismatch/)

    expect(state.createdWithdrawal).toBeNull()
    expect(state.archived).toBe(false)
  })

  test('avbryter om lån-ID inte stämmer', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    await expect(
      executeInterestPayment('Michael Brundins', 'INBOX', 1, { expectLoanNumber: 1234 }),
    ).rejects.toThrow(/Lån-ID mismatch/)

    expect(state.createdWithdrawal).toBeNull()
    expect(state.archived).toBe(false)
  })

  test('gör ingen utbetalning när tillgången hos Kameo inte räcker', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    state.availableAmount = '0.0000'

    await expect(executeInterestPayment('Michael Brundins', 'INBOX', 1)).rejects.toThrow(
      /räcker inte/,
    )

    expect(state.createdWithdrawal).toBeNull()
    expect(state.archived).toBe(false)
  })

  test('vägrar betala om en likadan begäran redan pågår', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    state.openRequests = [
      {
        id: 250526,
        amount: 11.67,
        status: 'Uttagsbegäran behandlas',
        destination_bank_account_id: 39973,
      },
    ]

    await expect(executeInterestPayment('Michael Brundins', 'INBOX', 1)).rejects.toThrow(
      /pågår redan hos Kameo/,
    )

    expect(state.createdWithdrawal).toBeNull()
    expect(state.archived).toBe(false)
  })

  test('vägrar betala när ett samlingsuttag redan täcker beloppet', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    // Ett uttag på summan av dagens räntebetalningar täcker även det enskilda
    // lånet - då ska det inte betalas igen.
    state.openRequests = [
      {
        id: 250526,
        amount: 47.29,
        status: 'Uttagsbegäran behandlas',
        destination_bank_account_id: 39973,
      },
    ]

    await expect(executeInterestPayment('Michael Brundins', 'INBOX', 1)).rejects.toThrow(
      /redan på väg ut/,
    )

    expect(state.createdWithdrawal).toBeNull()
  })

  test('kan hoppa över uttag och arkivering', async () => {
    const { executeInterestPayment } = await import('../utils/mail/kameo-interest-flow')

    const result = await executeInterestPayment('Michael Brundins', 'INBOX', 1, {
      skipWithdrawal: true,
      skipArchive: true,
    })

    expect(result.withdrawalId).toBeNull()
    expect(result.archived).toBe(false)
    expect(state.createdWithdrawal).toBeNull()
  })
})

describe('mappar', () => {
  test('rekommenderade mappar omfattar Kameo, raderade och arkivet', async () => {
    const { interestFolders } = await import('../utils/mail/kameo-interest-flow')

    const folders = await interestFolders('Michael Brundins')

    expect(folders).toContain('INBOX')
    expect(folders).toContain('INBOX.Kameo')
    expect(folders).toContain('INBOX.Kameo.Lån 5041')
    // De senaste räntebetalningsmejlen hamnade i Deleted Messages.
    expect(folders).toContain('INBOX.Deleted Messages')
    expect(folders).toContain('INBOX.Archive')
    // O Irrelevanta mappar ska inte sökas igenom.
    expect(folders).not.toContain('INBOX.Tessin')
  })

  test('söker bara i de mappar som väljs', async () => {
    const { findInterestEmails } = await import('../utils/mail/kameo-interest-flow')

    const emails = await findInterestEmails('Michael Brundins', {
      folders: ['INBOX.Kameo.Lån 5041'],
    })

    expect(emails.length).toBe(1)
    expect(emails[0]?.folder).toBe('INBOX.Kameo.Lån 5041')
    expect(emails[0]?.loanNumber).toBe(5041)

    // Bara den valda mappen ska ha lästs.
    const listedFolders = calls
      .filter((call) => call.url.includes('/emails?'))
      .map((call) => decodeURIComponent(new URL(call.url).pathname))
    expect(listedFolders).toEqual([
      '/api/v1/accounts/Michael Brundins/folders/INBOX.Kameo.Lån 5041/emails',
    ])
  })

  test('söker i flera valda mappar', async () => {
    const { findInterestEmails } = await import('../utils/mail/kameo-interest-flow')

    const emails = await findInterestEmails('Michael Brundins', {
      folders: ['INBOX.Kameo.Lån 5041', 'INBOX.Deleted Messages'],
    })

    expect(emails.length).toBe(2)
    expect(emails.map((email) => email.folder).sort()).toEqual([
      'INBOX.Deleted Messages',
      'INBOX.Kameo.Lån 5041',
    ])
  })
})
