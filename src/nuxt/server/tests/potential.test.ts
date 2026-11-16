import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_REVIEW_MONTHS,
  defaultReviewDate,
  formatDate,
  splitByPotential,
  toIsoDate,
} from '../../shared/utils/potential'

describe('defaultReviewDate', () => {
  test('lägger DEFAULT_REVIEW_MONTHS månader framåt', () => {
    expect(defaultReviewDate(new Date(2026, 0, 15))).toBe('2026-07-15')
  })

  test('hanterar månadslängdshopp (31 januari + 6 månader)', () => {
    // 31 juli har 31 dagar - ska inte rymma in i februari.
    expect(defaultReviewDate(new Date(2026, 0, 31))).toBe('2026-07-31')
  })

  test('defaulten är sex månader', () => {
    expect(DEFAULT_REVIEW_MONTHS).toBe(6)
  })
})

describe('toIsoDate', () => {
  test('formaterar som yyyy-mm-dd i lokal tid', () => {
    expect(toIsoDate(new Date(2026, 2, 1))).toBe('2026-03-01')
  })
})

describe('formatDate', () => {
  test('skriver ut svenskt datum', () => {
    expect(formatDate('2026-03-01')).toContain('2026')
  })

  test('tar tidsstämpel-format (från Postgres)', () => {
    expect(formatDate('2026-12-01T00:00:00.000Z')).toContain('2026')
  })

  test('saknat datum ger tankstreck', () => {
    expect(formatDate(null)).toBe('—')
  })

  test('trasig sträng returneras som den är', () => {
    expect(formatDate('inte ett datum')).toBe('inte ett datum')
  })
})

describe('splitByPotential', () => {
  const people = [
    { id: '1', is_potential: true },
    { id: '2', is_potential: false },
    { id: '3', is_potential: true },
  ]

  test('delar upp i potentiella och ej aktuella', () => {
    const { current, parked } = splitByPotential(people)
    expect(current.map(p => p.id)).toEqual(['1', '3'])
    expect(parked.map(p => p.id)).toEqual(['2'])
  })

  test('tom lista ger två tomma listor', () => {
    const { current, parked } = splitByPotential([])
    expect(current).toEqual([])
    expect(parked).toEqual([])
  })
})
