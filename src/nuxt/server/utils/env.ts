import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Läsning av enkel .env-filer (KEY="value").
 *
 * Samma mönster som för Neon-anslutningen: repot har en enda handhållen
 * kopia av hemligheterna, och koden letar upp den i stället för att
 * kräva att varje miljö sätter variabeln manuellt.
 */

/** Läs en enkel .env-fil. Returnerar tomt objekt om filen saknas. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}

  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    out[key] = value
  }
  return out
}

/**
 * Sökvägar som kontrolleras efter en lokal env-fil.
 *
 * Sökningen börjar i arbetskatalogen och går uppåt, så att filen hittas
 * oavsett om appen startas från repo-roten, från src/nuxt eller från en
 * byggkatalog:
 *
 *   <katalog>/.env
 *   <katalog>/src/nuxt/.env
 *   <katalog>/src/neon/.env.local
 */
export function localEnvPaths(): string[] {
  const paths: string[] = []
  let dir = process.cwd()

  for (let depth = 0; depth < 6; depth += 1) {
    paths.push(resolve(dir, '.env'))
    paths.push(resolve(dir, 'src/nuxt/.env'))
    paths.push(resolve(dir, 'src/neon/.env.local'))

    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  return paths
}

/**
 * Läs en nyckel ur den första lokala env-filen som innehåller den.
 *
 * Används för hemligheter som ska fungera både i `npm run dev` och när
 * produktionsbygget körs direkt på maskinen. I containern finns ingen
 * env-fil - där kommer värdet från Kubernetes Secret i stället.
 */
export function readLocalEnvValue(key: string): string {
  for (const path of localEnvPaths()) {
    const value = parseEnvFile(path)[key]
    if (value) return value
  }
  return ''
}
