import { describe, expect, test } from 'bun:test'
import {
  accountForClassification,
  formatInterestAmount,
  interestAccount,
  interestFileName,
  interestForDate,
  interestTransactions,
  isInterestEmail,
  parseLoanNumber,
  INTEREST_ACCOUNT_LONG,
  INTEREST_ACCOUNT_SHORT,
} from '../utils/mail/kameo-interest'

describe('formatInterestAmount', () => {
  test('använder komma som decimaltecken', () => {
    expect(formatInterestAmount(12.2)).toBe('12,2')
    expect(formatInterestAmount(11.67)).toBe('11,67')
  })

  test('tar bort trailinga nollor', () => {
    expect(formatInterestAmount(11.6700)).toBe('11,67')
    expect(formatInterestAmount(12)).toBe('12')
  })
})

describe('interestAccount', () => {
  test('kort lån går till 8313', () => {
    expect(interestAccount('kortsiktig')).toBe('8313')
    expect(INTEREST_ACCOUNT_SHORT).toBe('8313')
  })

  test('långt lån går till 8251', () => {
    expect(interestAccount('langsiktig')).toBe('8251')
    expect(INTEREST_ACCOUNT_LONG).toBe('8251')
  })

  test('okänd klassificering bokförs på det korta kontot', () => {
    expect(accountForClassification('okand')).toBe('8313')
  })

  test('långsiktig klassificering ger 8251', () => {
    expect(accountForClassification('langsiktig')).toBe('8251')
  })
})

describe('interestFileName', () => {
  test('filnamnet följer Kameo - lån - Ränteutbetalning - belopp - konto.pdf', () => {
    expect(interestFileName(5122, 12.2, 'kortsiktig')).toBe(
      'Kameo - 5122 - Ränteutbetalning - 12,2 kr - 8313.pdf',
    )
  })

  test('långsiktigt lån ger kontot 8251', () => {
    expect(interestFileName(4634, 11.67, 'langsiktig')).toBe(
      'Kameo - 4634 - Ränteutbetalning - 11,67 kr - 8251.pdf',
    )
  })

  test('lånnummer som sträng fungerar', () => {
    expect(interestFileName('5041', 11.67, 'kortsiktig')).toBe(
      'Kameo - 5041 - Ränteutbetalning - 11,67 kr - 8313.pdf',
    )
  })
})

describe('parseLoanNumber', () => {
  test('läser lånenumret ur ämnet', () => {
    expect(parseLoanNumber('Räntebetalning - lån 4634')).toBe(4634)
    expect(parseLoanNumber('Räntebetalning - lån 5133')).toBe(5133)
  })

  test('hanterar #-varianten', () => {
    expect(parseLoanNumber('Räntebetalning lån #4033 #52972')).toBe(4033)
  })

  test('läser lånenumret ur brödtexten när ämnet saknar det', () => {
    expect(parseLoanNumber('Räntebetalning', 'Lånenummer:   4815')).toBe(4815)
  })

  test('returnerar null när inget lånenummer finns', () => {
    expect(parseLoanNumber('Räntebetalning')).toBeNull()
    expect(parseLoanNumber('')).toBeNull()
  })
})

describe('isInterestEmail', () => {
  test('räntemejl från Kameo känns igen', () => {
    expect(isInterestEmail('Räntebetalning - lån 4634', 'Kameo <info@kameo.se>')).toBe(true)
  })

  test('andra avsändare accepteras inte', () => {
    expect(isInterestEmail('Räntebetalning - lån 4634', 'Svea <noreply@svea.se>')).toBe(false)
  })

  test('andra ämnen accepteras inte', () => {
    expect(isInterestEmail('Ränteutbetalning i lån #25123-1', 'Kameo <info@kameo.se>')).toBe(false)
  })
})

describe('interestTransactions', () => {
  const transactions = [
    { date: '2026-05-15', description: 'Tilldelning', amount: '-2000.00' },
    { date: '2026-06-15', description: 'Inkomstränta', amount: '11.67' },
    { date: '2026-07-15', description: 'Inkomstränta', amount: '11.67' },
    { date: '2026-08-15', description: 'Amortering', amount: '-100.00' },
  ]

  test('plockar ut ränteraderna', () => {
    const result = interestTransactions(transactions)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ date: '2026-06-15', description: 'Inkomstränta', amount: 11.67 })
  })

  test('summerar flera ränterader samma dag', () => {
    const result = interestTransactions([
      { date: '2026-11-16', description: 'Inkomstränta', amount: '10.00' },
      { date: '2026-11-16', description: 'Inkomstränta', amount: '2.50' },
    ])
    expect(interestForDate(result, '2026-11-16')).toBe(12.5)
  })

  test('returnerar null när datumet inte finns', () => {
    const result = interestTransactions(transactions)
    expect(interestForDate(result, '2026-12-15')).toBeNull()
  })
})
