import { describe, expect, test } from 'bun:test'
import { detectDelimiter, guessColumns, parseCsv } from '../utils/csv'

describe('parseCsv', () => {
  test('läser rubrik och rader', () => {
    const { header, rows } = parseCsv('Namn;Roll\nAnna;Backend\nBengt;Data\n')
    expect(header).toEqual(['Namn', 'Roll'])
    expect(rows).toEqual([
      ['Anna', 'Backend'],
      ['Bengt', 'Data'],
    ])
  })

  test('svensk Excel använder semikolon - men komma fungerar också', () => {
    expect(detectDelimiter('Namn;Roll\nAnna;Backend')).toBe(';')
    expect(detectDelimiter('Namn,Roll\nAnna,Backend')).toBe(',')
    const { rows } = parseCsv('Namn,Roll\nAnna,Backend\n')
    expect(rows[0]).toEqual(['Anna', 'Backend'])
  })

  test('citattecken och kommas inuti fält hanteras', () => {
    // I CSV är ett citattecken inuti ett citerat fält dubblerat.
    const { rows } = parseCsv('Namn;Anteckning\n"Anders, A.";"Han säger: ""ja, gärna"""\n')
    expect(rows[0]?.[0]).toBe('Anders, A.')
    expect(rows[0]?.[1]).toBe('Han säger: "ja, gärna"')
  })

  test('tomma rader hoppas över', () => {
    const { rows } = parseCsv('Namn\nAnna\n\n\nBengt\n')
    expect(rows).toHaveLength(2)
  })

  test('saknad fil ger tomt resultat, inte ett kast', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] })
  })
})

describe('guessColumns', () => {
  test('plannerrubriker hittas', () => {
    const guess = guessColumns(['Task Name', 'Description', 'Bucket Name', 'Company'])
    expect(guess.name).toBe(0)
    expect(guess.description).toBe(1)
    expect(guess.bucket).toBe(2)
    expect(guess.org).toBe(3)
  })

  test('svenska rubriker hittas', () => {
    const guess = guessColumns(['Namn', 'Beskrivning', 'Företag'])
    expect(guess.name).toBe(0)
    expect(guess.description).toBe(1)
    expect(guess.org).toBe(2)
  })

  test('saknad namnkolumn faller tillbaka på första kolumnen', () => {
    const guess = guessColumns(['Kolumn1', 'Kolumn2'])
    expect(guess.name).toBe(0)
    expect(guess.org).toBe(-1)
  })
})
