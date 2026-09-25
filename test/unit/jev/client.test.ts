import { describe, expect, it } from 'vitest'
import { APIError } from '@typesafe-ai/sdk'
import type { SubmissionSummary } from '#shared/utils/nav'
import { createJevClient, JEV_MODEL } from '#server/utils/jev/client'
import { JudgeError } from '#server/utils/jev/errors'
import { JUDGE_QUESTIONS } from '#server/utils/jev/questions'
import { answersFetch, fixtureFetch, jsonResponse, loadSubmissionFixtures } from './helpers'

const fixtures = loadSubmissionFixtures()

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
    const jev = createJevClient({ apiKey: 'test-key', fetch })
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
    const jev = createJevClient({ apiKey: 'test-key', fetch })
    const first = await jev.judgeSubmission(SUMMARY)
    const second = await jev.judgeSubmission(structuredClone(SUMMARY))
    expect(calls).toHaveLength(1)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.usage).toBeUndefined()
    expect({ ...second, cached: false, usage: first.usage }).toEqual(first)
  })

  it('shares an injected store between clients and misses on a different submission', async () => {
    const cache = new Map()
    const a = answersFetch(0.5)
    const b = answersFetch(0.5)
    await createJevClient({ apiKey: 'k', fetch: a.fetch, cache }).judgeSubmission(SUMMARY)
    const again = await createJevClient({ apiKey: 'k', fetch: b.fetch, cache }).judgeSubmission(
      SUMMARY,
    )
    expect(again.cached).toBe(true)
    expect(b.calls).toHaveLength(0)
    const other = { ...SUMMARY, mission_rules: `${SUMMARY.mission_rules} ` }
    await createJevClient({ apiKey: 'k', fetch: b.fetch, cache }).judgeSubmission(other)
    expect(b.calls).toHaveLength(1)
    expect(cache.size).toBe(2)
  })
})

describe('judgeSubmission verdict', () => {
  const verdictAt = async (
    noul: number,
    verdict?: { rejectBelow?: number; acceptAbove?: number },
  ) =>
    (
      await createJevClient({
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
    const judgment = await createJevClient({
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
        createJevClient({ apiKey, fetch: answersFetch(0.5).fetch })
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
    const cache = new Map()
    const jev = createJevClient({ apiKey: 'k', fetch, cache, maxRetries: 0 })
    const error = await judgeErrorOf(jev.judgeSubmission(SUMMARY))
    expect(error?.code).toBe('UPSTREAM')
    expect(error?.cause).toBeInstanceOf(APIError)
    expect((error!.cause as APIError).status).toBe(500)
    expect(error?.message).toContain('500')
    expect(calls).toBe(1)
    expect(cache.size).toBe(0)
  })

  it('is UPSTREAM on a timeout', async () => {
    const fetch = (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const jev = createJevClient({ apiKey: 'k', fetch, timeoutMs: 20, maxRetries: 0 })
    const error = await judgeErrorOf(jev.judgeSubmission(SUMMARY))
    expect(error?.code).toBe('UPSTREAM')
    expect(error?.cause).toBeDefined()
  })

  it('is UPSTREAM when the answers do not match the questions', async () => {
    const fetch = async () =>
      jsonResponse({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 0 } })
    const error = await judgeErrorOf(
      createJevClient({ apiKey: 'k', fetch }).judgeSubmission(SUMMARY),
    )
    expect(error?.code).toBe('UPSTREAM')
  })

  it('is INVALID_SUMMARY for a malformed or oversized summary, before any request', async () => {
    const { fetch, calls } = answersFetch(0.5)
    const jev = createJevClient({ apiKey: 'k', fetch })
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
