import type { Fetch } from '@typesafe-ai/sdk'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import * as v from 'valibot'
import type { SubmissionSummary } from '#shared/utils/nav/summary'
import { SubmissionSummarySchema } from '#shared/utils/nav/summary'
import { canonicalJson } from '#shared/utils/terrain/manifest'
import { JUDGE_UNAVAILABLE, JudgeError } from './errors'
import { JUDGE_QUESTIONS } from './questions'

/** Pinned model: answers are reproducible only within one model version. */
/** TypeSafe's public API; requests never go anywhere else whatever the environment says. */
export const TYPESAFE_API_URL = 'https://api.typesafe.ai'

export const JEV_MODEL = 'jev-1.13.0'

/** Largest summary judged, in JSON characters; Jev's accuracy drops as the state grows. */
export const MAX_SUMMARY_CHARS = 1500

/** One Score answer, `probabilities[k]` being the probability of level `k`. */
export interface ScoreJudgment {
  /** Expected level, 0 to the top level, fractional. */
  score: number
  confidence: number
  probabilities: number[]
}

/** The five answers as returned by Jev; what the cache stores. */
export interface JudgedAnswers {
  /** Probability that the rover completes the segment as planned. */
  feasible: number
  distanceConfidence: ScoreJudgment
  timeConfidence: ScoreJudgment
  risk: ScoreJudgment
  /** How much new ground the segment opens, lowest level the least. */
  explorationValue: ScoreJudgment
}

export type Verdict = 'reject' | 'review' | 'accept'

export interface SubmissionJudgment extends JudgedAnswers {
  /** `distanceConfidence.score` over its top level, 0 to 1: the vote tie-break weight. */
  distanceWeight: number
  /** `timeConfidence.score` over its top level, 0 to 1. */
  timeWeight: number
  /** `explorationValue.score` over its top level, 0 to 1: Jev's half of the exploration value. */
  explorationWeight: number
  verdict: Verdict
  /** True when answered from the cache without a request. */
  cached: boolean
  /** Set only when a request was made. */
  usage?: { inputTokens: number }
}

/**
 * Where judged answers are kept, by request hash ({@link jevRequestKey}). The server keeps them in
 * the database so an identical submission is never paid for twice, across instances and deploys.
 */
export interface JevCache {
  get(hash: string): Promise<JudgedAnswers | undefined>
  /** Keeps the first answers stored under `hash`; a later write of the same hash changes nothing. */
  set(hash: string, value: JudgedAnswers): Promise<void>
}

/**
 * The server's limits on a Jev request: a settlement waits for its re-judgments, so a request
 * that never answers must fail as `UPSTREAM` well within a function's lifetime.
 */
export const JEV_SERVER_LIMITS = { timeoutMs: 20_000, maxRetries: 1 } as const

/**
 * Where the judgments come from, in order of preference: the project's own TypeSafe key
 * (`typesafeToken`, from `NUXT_TYPESAFE_TOKEN`) against the public API, else the hosting
 * platform's AI gateway when it injects `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` into the
 * runtime (billed to the hosting account, no TypeSafe account needed), else nothing, which the
 * client reports as `NOT_CONFIGURED`.
 */
export function jevCredentialsOf(typesafeToken: string | undefined): {
  apiKey: string | undefined
  baseURL: string
} {
  const own = typesafeToken?.trim()
  if (own) return { apiKey: own, baseURL: TYPESAFE_API_URL }
  const gatewayKey = process.env.TYPESAFE_API_KEY?.trim()
  const gatewayURL = process.env.TYPESAFE_BASE_URL?.trim()
  if (gatewayKey && gatewayURL) return { apiKey: gatewayKey, baseURL: gatewayURL }
  return { apiKey: undefined, baseURL: TYPESAFE_API_URL }
}

/**
 * A client created by `create` on its first judgment, so a caller works without a key until a
 * judgment needs one; a failed creation is tried again on the next judgment.
 */
export function lazyJevClient(create: () => JevClient): JevClient {
  let client: JevClient | undefined
  return {
    judgeSubmission: (summary, options) => (client ??= create()).judgeSubmission(summary, options),
  }
}

export interface JevClientOptions {
  /** Where the API lives; the public endpoint unless a test points elsewhere. */
  baseURL?: string
  /** TypeSafe API key; empty or missing throws `NOT_CONFIGURED`. */
  apiKey: string | undefined
  fetch?: Fetch
  cache: JevCache
  /** Per attempt. Default: the SDK's 10 s. */
  timeoutMs?: number
  /** Retries after the first attempt on 408, 429, 5xx and connection failures. Default: the SDK's 2. */
  maxRetries?: number
  verdict?: {
    /** `feasible` below this rejects. Default 0.2. */
    rejectBelow?: number
    /** `feasible` above this accepts; in between goes to review. Default 0.8. */
    acceptAbove?: number
  }
}

export interface JevClient {
  judgeSubmission(
    summary: SubmissionSummary,
    options?: { signal?: AbortSignal },
  ): Promise<SubmissionJudgment>
}

/** The request body sent for one submission. */
export interface JudgeRequest {
  model: string
  state: SubmissionSummary
  questions: typeof JUDGE_QUESTIONS
}

/**
 * Hex SHA-256 of the canonical JSON of a request body as it goes on the wire (the JSON round
 * trip drops `undefined` fields exactly as the request does).
 */
export async function jevRequestKey(request: {
  model: string
  state: unknown
  questions: unknown
}): Promise<string> {
  const wire = JSON.parse(JSON.stringify(request)) as unknown
  const bytes = new TextEncoder().encode(canonicalJson(wire))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = options.apiKey?.trim()
  if (!apiKey) {
    throw new JudgeError(
      'NOT_CONFIGURED',
      'Jev has no TypeSafe API key; set NUXT_TYPESAFE_TOKEN (runtimeConfig.typesafeToken).',
    )
  }
  const { rejectBelow = 0.2, acceptAbove = 0.8 } = options.verdict ?? {}
  const { cache } = options
  /*
   * The base URL is pinned: the SDK would otherwise take it from the environment, and a hosting
   * platform's AI gateway can inject a provider URL of its own there, which then refuses this
   * project's key.
   */
  const client = new TypeSafeClient({
    apiKey,
    baseURL: options.baseURL ?? TYPESAFE_API_URL,
    defaultModel: JEV_MODEL,
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
    ...(options.maxRetries !== undefined && { retry: { maxRetries: options.maxRetries } }),
  })

  function judgmentOf(answers: JudgedAnswers, cached: boolean, inputTokens?: number) {
    const top = (judgment: ScoreJudgment) => judgment.probabilities.length - 1
    const verdict: Verdict =
      answers.feasible < rejectBelow
        ? 'reject'
        : answers.feasible > acceptAbove
          ? 'accept'
          : 'review'
    return {
      // A copy, so callers never mutate what the cache holds.
      ...structuredClone(answers),
      distanceWeight: answers.distanceConfidence.score / top(answers.distanceConfidence),
      timeWeight: answers.timeConfidence.score / top(answers.timeConfidence),
      explorationWeight: answers.explorationValue.score / top(answers.explorationValue),
      verdict,
      cached,
      ...(inputTokens !== undefined && { usage: { inputTokens } }),
    } satisfies SubmissionJudgment
  }

  return {
    async judgeSubmission(summary, callOptions = {}) {
      const state = parseSummary(summary)
      const request: JudgeRequest = { model: JEV_MODEL, state, questions: JUDGE_QUESTIONS }
      const key = await jevRequestKey(request)
      const hit = await cache.get(key)
      if (hit) return judgmentOf(hit, true)

      let result: unknown
      try {
        result = await client.systemOne(request, { signal: callOptions.signal })
      } catch (error) {
        throw new JudgeError('UPSTREAM', JUDGE_UNAVAILABLE, { cause: error })
      }
      const parsed = v.safeParse(ResultSchema, result)
      if (!parsed.success) {
        throw new JudgeError('UPSTREAM', JUDGE_UNAVAILABLE, {
          cause: new Error(
            `Jev answered outside the questions asked: ${describeIssue(parsed.issues)}.`,
            { cause: new v.ValiError(parsed.issues) },
          ),
        })
      }
      const { answers, usage } = parsed.output
      const judged: JudgedAnswers = {
        feasible: answers.feasible.noul,
        distanceConfidence: scoreJudgment(answers.distance_confidence),
        timeConfidence: scoreJudgment(answers.time_confidence),
        risk: scoreJudgment(answers.risk),
        explorationValue: scoreJudgment(answers.exploration_value),
      }
      await cache.set(key, judged)
      return judgmentOf(judged, false, usage.input_tokens)
    },
  }
}

function parseSummary(summary: SubmissionSummary): SubmissionSummary {
  const parsed = v.safeParse(SubmissionSummarySchema, summary)
  if (!parsed.success) {
    throw new JudgeError(
      'INVALID_SUMMARY',
      `Submission summary is invalid: ${describeIssue(parsed.issues)}. Build it with summarizeSubmission.`,
      { cause: new v.ValiError(parsed.issues) },
    )
  }
  const chars = JSON.stringify(parsed.output).length
  if (chars > MAX_SUMMARY_CHARS) {
    throw new JudgeError(
      'INVALID_SUMMARY',
      `Submission summary is ${chars} JSON characters; keep it within ${MAX_SUMMARY_CHARS}, since Jev's accuracy drops as its state grows.`,
    )
  }
  return parsed.output
}

function describeIssue(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string {
  const [issue] = issues
  return `${v.getDotPath(issue) ?? '(root)'} ${issue.message}`
}

const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1))

function scoreSchema(levels: number) {
  return v.object({
    type: v.literal('score'),
    score: v.pipe(v.number(), v.minValue(0), v.maxValue(levels - 1)),
    confidence: probability,
    probabilities: v.object(
      Object.fromEntries(Array.from({ length: levels }, (_, k) => [`${k}`, probability])),
    ),
  })
}

const ResultSchema = v.object({
  answers: v.object({
    feasible: v.object({ type: v.literal('noul'), noul: probability }),
    distance_confidence: scoreSchema(JUDGE_QUESTIONS.distance_confidence.criteria.length),
    time_confidence: scoreSchema(JUDGE_QUESTIONS.time_confidence.criteria.length),
    risk: scoreSchema(JUDGE_QUESTIONS.risk.criteria.length),
    exploration_value: scoreSchema(JUDGE_QUESTIONS.exploration_value.criteria.length),
  }),
  usage: v.object({ input_tokens: v.number() }),
})

function scoreJudgment(answer: {
  score: number
  confidence: number
  probabilities: Record<string, number>
}): ScoreJudgment {
  const levels = Object.keys(answer.probabilities).length
  return {
    score: answer.score,
    confidence: answer.confidence,
    probabilities: Array.from({ length: levels }, (_, k) => answer.probabilities[`${k}`]!),
  }
}
