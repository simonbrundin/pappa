/**
 * Hjälpfunktioner för kandidatens potential.
 *
 * "Aktuell" = personen ligger i rekryteringspoolen och kan kontaktas nu.
 * "Parkrad" (is_potential = false) = personen är inte aktuell NU, men kan
 * bli aktuell igen - därför sparar vi ett datum för nästa genomgång.
 */

/**
 * Flikarna i /kandidater.
 *
 * "Potentiella" = kandidaten är i den aktiva rekryteringspoolen.
 * "Ej aktuella" = kandidaten är parkerad (inte aktuell just nu).
 */
export type PotentialTab = 'potentiella' | 'ej-aktuella'

/** Standardorsaker till att en kandidat inte är aktuell nu. */
export const NOT_RELEVANT_REASONS = [
  'Driver eget bolag',
  'Anställd - vill inte',
  'Bytt yrke eller region',
  'Bosatt på fel ort',
  'Tillfälligt otillgänglig',
  'Övrigt',
] as const

/** Hur många månader framåt nästa genomgång ligger som default. */
export const DEFAULT_REVIEW_MONTHS = 6

/** yyyy-mm-dd i lokal tid - UTC-skift skulle annars kunna flytta dagen. */
export function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Dagens datum som yyyy-mm-dd. */
export function todayIso(): string {
  return toIsoDate(new Date())
}

/** Defaultdatum för nästa genomgång - dvs om X månader. */
export function defaultReviewDate(from: Date = new Date()): string {
  const date = new Date(from.getTime())
  date.setMonth(date.getMonth() + DEFAULT_REVIEW_MONTHS)
  return toIsoDate(date)
}

function parseIsoDate(value: string): Date | null {
  // Postgres kan returnera datum som tidsstämpel ("2026-12-01T00:00:00.000Z") -
  // vi bryter bort tidsdelen.
  const day = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date) return null
  const parsed = new Date(year, month - 1, date)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Datum i svensk form: 2026-03-01 -> "1 mars 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = parseIsoDate(value)
  if (!date) return value
  return date.toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Dela upp personerna i aktuella och parkerade.
 * Sorteringen (namn/organisation) sker i vyn - här splittas bara listan.
 */
export function splitByPotential<T extends { is_potential: boolean }>(
  people: T[],
): { current: T[]; parked: T[] } {
  const current: T[] = []
  const parked: T[] = []
  for (const person of people) {
    if (person.is_potential) current.push(person)
    else parked.push(person)
  }
  return { current, parked }
}
