/**
 * Helpers shared by the Jev scripts (`jev-record.ts`, `jev-route-choice.ts`); not a script itself.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StopDisk, World } from '#shared/utils/terrain'
import {
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  revealedOverDisk,
} from '#shared/utils/terrain'

export const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/jev/', import.meta.url))

/** The first stop of a journey on `seed`: the disk at the origin with only its own view revealed. */
export function firstStop(seed: string): { world: World; disk: StopDisk; revealed: Uint8Array } {
  const world = defineWorld({ seed })
  const disk = computeStopDisk(world, { center: { x: 0, y: 0 } })
  const revealed = revealedOverDisk(revealDisk(createRevealedMask(world), disk), disk)
  return { world, disk, revealed }
}

/** The API key from `.env`; exits with a message when it is missing. Never printed. */
export function apiKeyFromEnv(): string {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const key = process.env.NUXT_TYPESAFE_TOKEN?.trim()
  if (!key) {
    console.error('NUXT_TYPESAFE_TOKEN is not set; add it to .env.')
    process.exit(1)
  }
  return key
}

export interface Exchange {
  request: unknown
  response: unknown
}

/**
 * The global fetch, keeping each request body and parsed response body. Headers (and so the API
 * key) are never kept.
 */
export function recordingFetch(): { fetch: typeof fetch; exchanges: Exchange[] } {
  const exchanges: Exchange[] = []
  const recording = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init)
    const body = (await response.clone().json()) as unknown
    exchanges.push({ request: JSON.parse(bodyText(init)) as unknown, response: body })
    return response
  }
  return { fetch: recording as typeof fetch, exchanges }
}

export function writeFixture(name: string, value: unknown): string {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const path = `${FIXTURE_DIR}${name}.json`
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

/** Prints a Markdown table. */
export function printTable(head: string[], body: string[][]): void {
  for (const line of [head, head.map(() => '---'), ...body]) console.log(`| ${line.join(' | ')} |`)
}

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.')
  return init.body
}
