import type { MissionRules } from '../../mission/rules'
import { rankSubmissions } from '../../mission/rules'

type Instant = Date | string | number

/** A submission as the public mission state lists it; only what ranking needs. */
export interface RoundSubmission {
  id: string
  likes: number
  /** The goal's exploration value, 0 to 1. */
  exploration: number
  createdAt: Instant
  submitter: { id: string }
  /** Written by the author of the drive the round runs beside: ranked after everyone else's. */
  deferred: boolean
  judgment: { risk: number; distanceWeight: number; timeWeight: number }
}

/**
 * The public round's submissions in standing order, the one that would win now first, as the
 * server ranks them: the ranking score from LGTMs and exploration, the mission tie-break, and the
 * driving author's pick after the others.
 */
export function rankRound<T extends RoundSubmission>(
  submissions: readonly T[],
  options: { rules: MissionRules },
): T[] {
  const drivingAuthorId = submissions.find((s) => s.deferred)?.submitter.id ?? null
  return rankSubmissions(
    submissions.map((s) => ({
      id: s.id,
      userId: s.submitter.id,
      likes: s.likes,
      exploration: s.exploration,
      createdAt: new Date(s.createdAt),
      judgment: { ...s.judgment, risk: { score: s.judgment.risk } },
      source: s,
    })),
    { rules: options.rules, drivingAuthorId },
  ).map((entry) => entry.source)
}

/**
 * Where the vote stands. `idle`: no drive and no submission, nothing closes until one arrives.
 * `open`: a drive plays and the vote closes when it ends, a time kept private. `planning`: the
 * drive has ended and the vote closes at `closesAt`, the planning phase.
 */
export type RoundPhase = { leader: { id: string; likes: number } | null } & (
  | { kind: 'idle' }
  | { kind: 'open' }
  | { kind: 'planning'; closesAtMs: number; remainingMs: number; fraction: number }
)

/** The phase at `nowMs` of the public open round, with the submission currently winning. */
export function roundPhase(options: {
  round: { closesAt: Instant | null; submissions: readonly RoundSubmission[] } | null
  driving: boolean
  nowMs: number
  rules: MissionRules
}): RoundPhase {
  const { round, driving, nowMs, rules } = options
  const [first] = rankRound(round?.submissions ?? [], { rules })
  const leader = first ? { id: first.id, likes: first.likes } : null
  if (round?.closesAt != null) {
    const closesAtMs = new Date(round.closesAt).getTime()
    const remainingMs = Math.max(0, closesAtMs - nowMs)
    return {
      kind: 'planning',
      leader,
      closesAtMs,
      remainingMs,
      fraction: Math.min(1, remainingMs / rules.graceWindowMs),
    }
  }
  return { kind: driving && round ? 'open' : 'idle', leader }
}
