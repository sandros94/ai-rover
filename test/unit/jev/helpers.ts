import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SubmissionSummary } from '#shared/utils/nav'
import type { JevCache, JudgedAnswers } from '#server/utils/jev/client'
import { jevRequestKey } from '#server/utils/jev/client'

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/jev/', import.meta.url))

export interface JevFixture {
  name: string
  request: { model: string; state: SubmissionSummary; questions: Record<string, unknown> }
  response: {
    model: string
    answers: Record<string, Record<string, unknown>>
    usage: { input_tokens: number; output_tokens: number }
  }
}

/** The recorded submission fixtures (route-choice evidence files are not test inputs). */
export function loadSubmissionFixtures(): JevFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json') && !file.startsWith('route-choice-'))
    .sort()
    .map((file) => ({
      name: file.replace(/\.json$/, ''),
      ...(JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as Omit<JevFixture, 'name'>),
    }))
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A fetch that answers each request with the fixture recorded for the same request hash, and
 * fails loudly with that hash when none was recorded. `bodies` collects every parsed request body.
 */
export async function fixtureFetch(fixtures: JevFixture[]) {
  const byKey = new Map<string, JevFixture>()
  for (const fixture of fixtures) byKey.set(await jevRequestKey(fixture.request), fixture)
  const bodies: unknown[] = []
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(bodyText(init)) as JevFixture['request']
    bodies.push(body)
    const key = await jevRequestKey(body)
    const fixture = byKey.get(key)
    if (!fixture) {
      throw new Error(
        `No Jev fixture recorded for request ${key}; re-record with scripts/jev-record.ts.`,
      )
    }
    return jsonResponse(fixture.response)
  }
  return { fetch, bodies }
}

/** A fetch answering every request with the given noul and mid-level scores. */
export function answersFetch(feasible: number) {
  const calls: unknown[] = []
  const levels = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, k) => [`${k}`, k === n - 2 ? 1 : 0]))
  const scoreOf = (n: number) => ({
    type: 'score',
    score: n - 2,
    confidence: 1,
    legend: {},
    probabilities: levels(n),
  })
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    calls.push(JSON.parse(bodyText(init)))
    return jsonResponse({
      model: 'jev-1.13.0',
      answers: {
        feasible: { type: 'noul', noul: feasible },
        distance_confidence: scoreOf(5),
        time_confidence: scoreOf(5),
        risk: scoreOf(4),
      },
      usage: { input_tokens: 700, output_tokens: 20 },
    })
  }
  return { fetch, calls }
}

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.')
  return init.body
}

/** An in-memory Jev cache; `entries` shows what it holds. */
export function memoryJevCache(): { cache: JevCache; entries: Map<string, JudgedAnswers> } {
  const entries = new Map<string, JudgedAnswers>()
  return {
    entries,
    cache: {
      get: async (hash) => entries.get(hash),
      set: async (hash, value) => {
        entries.set(hash, value)
      },
    },
  }
}
