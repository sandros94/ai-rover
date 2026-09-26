import { describe, expect, it } from 'vitest'
import { APIError } from '@typesafe-ai/sdk'
import type { SubmissionSummary } from '#shared/utils/nav'
import type { JevClientOptions } from '#server/utils/jev/client'
import { createJevClient, JEV_MODEL } from '#server/utils/jev/client'
import { JUDGE_UNAVAILABLE } from '#server/utils/jev/errors'
import { JudgeError } from '#server/utils/jev/errors'
import { JUDGE_QUESTIONS } from '#server/utils/jev/questions'
import {
  answersFetch,
  fixtureFetch,
  jsonResponse,
  loadSubmissionFixtures,
  memoryJevCache,
} from './helpers'

const fixtures = loadSubmissionFixtures()

/** A client over its own in-memory cache unless one is given. */
function jevClient(
  options: Omit<JevClientOptions, 'cache'> & Partial<Pick<JevClientOptions, 'cache'>>,
) {
  return createJevClient({ cache: memoryJevCache().cache, ...options })
}

const SUMMARY: SubmissionSummary = fixtures[0]?.request.state ?? {
  rover: { class: 'rover', speed: 'slow', limits: 'none' },
  mission_rules: 'rules',
  destination: { straight_line_m: 120, straight_line_label: 'medium', bearing: 'east' },
  route: { reached: false },
  failure_reason: 'blocked',
}

async function judgeErrorOf(promise: Promise<unknown>): Promise<JudgeError | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof JudgeError) return error
    throw error
  }
  return undefined
}

describe('judgeSubmission over recorded fixtures', () => {
  it('has the six recorded submissions', () => {
    expect(fixtures.length).toBe(6)
    expect(fixtures.some((f) => !f.request.state.route.reached)).toBe(true)
  })

  it('sends exactly the recorded request and returns its typed judgment', async () => {
    const { fetch, bodies } = await fixtureFetch(fixtures)
    const jev = jevClient({ apiKey: 'test-key', fetch })
    for (const fixture of fixtures) {
      const judgment = await jev.judgeSubmission(fixture.request.state)
      expect(bodies.at(-1)).toEqual(fixture.request)
      const { answers, usage } = fixture.response
      const noul = answers.feasible!.noul as number
      const distance = answers.distance_confidence!
      const time = answers.time_confidence!
      const risk = answers.risk!
      expect(judgment.feasible).toBe(noul)
      expect(judgment.distanceConfidence.score).toBe(distance.score)
      expect(judgment.distanceConfidence.confidence).toBe(distance.confidence)
      expect(judgment.distanceConfidence.probabilities).toHaveLength(5)
      expect(judgment.distanceConfidence.probabilities[0]).toBe(
        (distance.probabilities as Record<string, number>)['0'],
      )
      expect(judgment.timeConfidence.score).toBe(time.score)
      expect(judgment.risk.score).toBe(risk.score)
      expect(judgment.risk.probabilities).toHaveLength(4)
      expect(judgment.distanceWeight).toBe((distance.score as number) / 4)
      expect(judgment.timeWeight).toBe((time.score as number) / 4)
      expect(judgment.verdict).toBe(noul < 0.2 ? 'reject' : noul > 0.8 ? 'accept' : 'review')
      expect(judgment.cached).toBe(false)
      expect(judgment.usage).toEqual({ inputTokens: usage.input_tokens })
    }
  })

  it('pins the model and asks the four questions', () => {
    for (const fixture of fixtures) {
      expect(fixture.request.model).toBe(JEV_MODEL)
      expect(fixture.request.questions).toEqual(JSON.parse(JSON.stringify(JUDGE_QUESTIONS)))
    }
    expect(JEV_MODEL).toBe('jev-1.13.0')
    expect(Object.keys(JUDGE_QUESTIONS).sort()).toEqual(
      ['distance_confidence', 'feasible', 'risk', 'time_confidence'].sort(),
    )
  })
})

describe('judgeSubmission cache', () => {
  it('answers an identical submission from the cache without a second request', async () => {
    const { fetch, calls } = answersFetch(0.9)
    const jev = jevClient({ apiKey: 'test-key', fetch })
    const first = await jev.judgeSubmission(SUMMARY)
    const second = await jev.judgeSubmission(structuredClone(SUMMARY))
    expect(calls).toHaveLength(1)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.usage).toBeUndefined()
    expect({ ...second, cached: false, usage: first.usage }).toEqual(first)
  })

  it('shares an injected store between clients and misses on a different submission', async () => {
    const { cache, entries } = memoryJevCache()
    const a = answersFetch(0.5)
    const b = answersFetch(0.5)
    await jevClient({ apiKey: 'k', fetch: a.fetch, cache }).judgeSubmission(SUMMARY)
    const again = await jevClient({ apiKey: 'k', fetch: b.fetch, cache }).judgeSubmission(SUMMARY)
    expect(again.cached).toBe(true)
    expect(b.calls).toHaveLength(0)
    const other = { ...SUMMARY, mission_rules: `${SUMMARY.mission_rules} ` }
    await jevClient({ apiKey: 'k', fetch: b.fetch, cache }).judgeSubmission(other)
    expect(b.calls).toHaveLength(1)
    expect(entries.size).toBe(2)
  })

  it('reads and writes through an async store, keyed by the request hash', async () => {
    const log: string[] = []
    const { cache: memory, entries } = memoryJevCache()
    const cache = {
      async get(hash: string) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        log.push(`get ${hash}`)
        return memory.get(hash)
      },
      async set(hash: string, value: Parameters<typeof memory.set>[1]) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        log.push(`set ${hash}`)
        await memory.set(hash, value)
      },
    }
    const { fetch, calls } = answersFetch(0.9)
    const jev = jevClient({ apiKey: 'k', fetch, cache })
    await jev.judgeSubmission(SUMMARY)
    const [hash] = [...entries.keys()]
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(log).toEqual([`get ${hash}`, `set ${hash}`])
    expect((await jev.judgeSubmission(SUMMARY)).cached).toBe(true)
    expect(log).toEqual([`get ${hash}`, `set ${hash}`, `get ${hash}`])
    expect(calls).toHaveLength(1)
  })
})

describe('judgeSubmission verdict', () => {
  const verdictAt = async (
    noul: number,
    verdict?: { rejectBelow?: number; acceptAbove?: number },
  ) =>
    (
      await jevClient({
        apiKey: 'k',
        fetch: answersFetch(noul).fetch,
        verdict,
      }).judgeSubmission(SUMMARY)
    ).verdict

  it('rejects below 0.2, accepts above 0.8 and sends the rest to review', async () => {
    expect(await verdictAt(0.1999)).toBe('reject')
    expect(await verdictAt(0.2)).toBe('review')
    expect(await verdictAt(0.8)).toBe('review')
    expect(await verdictAt(0.8001)).toBe('accept')
  })

  it('takes other thresholds', async () => {
    expect(await verdictAt(0.35, { rejectBelow: 0.4 })).toBe('reject')
    expect(await verdictAt(0.65, { acceptAbove: 0.6 })).toBe('accept')
  })

  it('derives the weights from the expected scores', async () => {
    const judgment = await jevClient({
      apiKey: 'k',
      fetch: answersFetch(0.5).fetch,
    }).judgeSubmission(SUMMARY)
    expect(judgment.distanceWeight).toBe(3 / 4)
    expect(judgment.timeWeight).toBe(3 / 4)
    expect(judgment.risk.score).toBe(2)
    expect(judgment.distanceConfidence.probabilities).toEqual([0, 0, 0, 1, 0])
  })
})

describe('judgeSubmission errors', () => {
  it('is NOT_CONFIGURED without an API key', () => {
    for (const apiKey of [undefined, '', '   ']) {
      let error: unknown
      try {
        jevClient({ apiKey, fetch: answersFetch(0.5).fetch })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(JudgeError)
      expect((error as JudgeError).code).toBe('NOT_CONFIGURED')
      expect((error as JudgeError).message).toContain('NUXT_TYPESAFE_TOKEN')
    }
  })

  it('is UPSTREAM with the SDK error as cause on a 500, and caches nothing', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return jsonResponse({ detail: 'boom' }, 500)
    }
    const { cache, entries } = memoryJevCache()
    const jev = jevClient({ apiKey: 'k', fetch, cache, maxRetries: 0 })
    const error = await judgeErrorOf(jev.judgeSubmission(SUMMARY))
    expect(error?.code).toBe('UPSTREAM')
    expect(error?.cause).toBeInstanceOf(APIError)
    expect((error!.cause as APIError).status).toBe(500)
    // The public message is fixed; what the service said stays in the cause.
    expect(error?.message).toBe(JUDGE_UNAVAILABLE)
    expect(error?.message).not.toMatch(/500|boom/)
    expect(calls).toBe(1)
    expect(entries.size).toBe(0)
  })

  it('is UPSTREAM on a timeout', async () => {
    const fetch = (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const jev = jevClient({ apiKey: 'k', fetch, timeoutMs: 20, maxRetries: 0 })
    const error = await judgeErrorOf(jev.judgeSubmission(SUMMARY))
    expect(error?.code).toBe('UPSTREAM')
    expect(error?.cause).toBeDefined()
    expect(error?.message).toBe(JUDGE_UNAVAILABLE)
  })

  it('is UPSTREAM when the answers do not match the questions', async () => {
    const fetch = async () =>
      jsonResponse({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 0 } })
    const error = await judgeErrorOf(jevClient({ apiKey: 'k', fetch }).judgeSubmission(SUMMARY))
    expect(error?.code).toBe('UPSTREAM')
    expect(error?.message).toBe(JUDGE_UNAVAILABLE)
    expect((error!.cause as Error).message).toMatch(/answers/)
  })

  it('is INVALID_SUMMARY for a malformed or oversized summary, before any request', async () => {
    const { fetch, calls } = answersFetch(0.5)
    const jev = jevClient({ apiKey: 'k', fetch })
    const missing = { ...SUMMARY, destination: undefined } as unknown as SubmissionSummary
    const huge = { ...SUMMARY, mission_rules: 'x'.repeat(1500) }
    const reachedWithReason = {
      ...SUMMARY,
      route: { reached: false },
      failure_reason: undefined,
    } as SubmissionSummary
    for (const summary of [missing, huge, reachedWithReason]) {
      const error = await judgeErrorOf(jev.judgeSubmission(summary))
      expect(error?.code).toBe('INVALID_SUMMARY')
    }
    expect(calls).toHaveLength(0)
  })
})
