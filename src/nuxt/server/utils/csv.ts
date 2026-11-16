/**
 * Minimal CSV-läsare för Planner-exporten.
 *
 * Planeras in i svensk Excel - där är semikolon vanligare än komma. Vi
 * detekterar avgränsaren automatiskt, annars hamnar hela raden i en kolumn.
 */

export interface ParsedCsv {
  header: string[]
  rows: string[][]
}

/** Räknar avgränsare utanför citattecken - citat kan innehålla komman. */
function countOutsideQuotes(line: string, char: string): number {
  let count = 0
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === char && !inQuotes) count++
  }
  return count
}

/** Delimiter: flest semikolon vinner över komma (svensk Excel). */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find(l => l.trim() !== '') ?? ''
  const semicolons = countOutsideQuotes(line, ';')
  const commas = countOutsideQuotes(line, ',')
  if (semicolons > commas) return ';'
  if (commas > 0) return ','
  return ';'
}

/** Delar en rad med citattecken, dubbla citattecken blir ett citattecken. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells.map(c => c.trim())
}

/**
 * Läser en CSV-text. första raden är rubrik. Tomma rader hoppas över.
 */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const delimiter = detectDelimiter(clean)
  const lines = clean.split('\n').filter(l => l.trim() !== '')

  if (!lines.length) return { header: [], rows: [] }

  const header = splitLine(lines[0] ?? '', delimiter)
  const rows = lines.slice(1).map(line => splitLine(line, delimiter))
  return { header, rows }
}

export interface ColumnGuess {
  name: number
  org: number
  description: number
  bucket: number
}

/**
 * Gissar vilka kolumner som innehåller namn, organisation, beskrivning och
 * bucket. Rubriknamnen varierar mellan Planner-exporter ("Task Name",
 * "Title", "Namn") och Excel ("Namn", "Företag").
 */
export function guessColumns(header: string[]): ColumnGuess {
  const find = (patterns: RegExp[]): number => {
    for (const pattern of patterns) {
      const index = header.findIndex(h => pattern.test((h ?? '').toLowerCase()))
      if (index !== -1) return index
    }
    return -1
  }

  const name = find([/^(task name|task title|title|name|namn|kandidat|candidate)/])
  const org = find([/org|företag|company|bolag|arbetsgivare|workplace|organisation|organization/])
  const description = find([/description|beskrivning|preview|notes|anteckning|comment/])
  const bucket = find([/bucket|segment|kolumn|column|status|läge/])

  return {
    name: name === -1 ? 0 : name,
    org: org === -1 ? -1 : org,
    description: description === -1 ? -1 : description,
    bucket: bucket === -1 ? -1 : bucket,
  }
}
