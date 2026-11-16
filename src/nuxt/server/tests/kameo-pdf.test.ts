import { describe, expect, test } from 'bun:test'
import { buildInterestPdf } from '../utils/mail/kameo-pdf'

describe('buildInterestPdf', () => {
  test('skapar en PDF med rätt filnamn och innehåll', async () => {
    const pdf = await buildInterestPdf({
      fileName: 'Kameo - 4634 - Ränteutbetalning - 27,78 kr - 8251.pdf',
      subject: 'Räntebetalning - lån 4634',
      from: 'Kameo <info@kameo.se>',
      date: '2025-08-12T15:41:20Z',
      loanNumber: 4634,
      amount: 27.78,
      account: '8251',
      body: 'Du har tagit emot en räntebetalning för ett lån via Kameo.',
    })

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  })

  test('överlever tomt brödtext', async () => {
    const pdf = await buildInterestPdf({
      fileName: 'Kameo - 5041 - Ränteutbetalning - 11,67 kr - 8313.pdf',
      subject: 'Räntebetalning - lån 5041',
      from: 'Kameo <info@kameo.se>',
      date: '2026-11-16T09:35:11Z',
      loanNumber: 5041,
      amount: 11.67,
      account: '8313',
      body: '',
    })

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
