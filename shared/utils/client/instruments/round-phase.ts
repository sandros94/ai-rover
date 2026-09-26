import type { MissionRules } from '../../mission/rules'
import { rankSubmissions } from '../../mission/rules'

type Instant = Date | string | number

/** A submission as the public mission state lists it; only what ranking needs. */
export interface RoundSubmission {
  id: string
  likes: number
  createdAt: Instant
  judgment: { risk: number; distanceWeight: number; timeWeight: number }
}

/**
 * Where the vote stands. `idle`: no drive and no submission, nothing closes until one arrives.
 * `open`: a drive plays and the vote closes when it ends, a time kept private. `grace`: the
 * drive has ended and the vote closes at `closesAt`.
 */
export type RoundPhase = { leader: { id: string; likes: number } | null } & (
  | { kind: 'idle' }
  | { kind: 'open' }
  | { kind: 'grace'; closesAtMs: number; remainingMs: number; fraction: number }
)

/** The phase at `nowMs` of the public open round, with the submission currently winning. */
export function roundPhase(options: {
  round: { closesAt: Instant | null; submissions: readonly RoundSubmission[] } | null
  driving: boolean
  nowMs: number
  rules: MissionRules
}): RoundPhase {
  const { round, driving, nowMs, rules } = options
  const ranked = rankSubmissions(
    (round?.submissions ?? []).map((s) => ({
      id: s.id,
      likes: s.likes,
      createdAt: new Date(s.createdAt),
      judgment: { ...s.judgment, risk: { score: s.judgment.risk } },
    })),
    { rules },
  )
  const leader = ranked[0] ? { id: ranked[0].id, likes: ranked[0].likes } : null
  if (round?.closesAt != null) {
    const closesAtMs = new Date(round.closesAt).getTime()
    const remainingMs = Math.max(0, closesAtMs - nowMs)
    return {
      kind: 'grace',
      leader,
      closesAtMs,
      remainingMs,
      fraction: Math.min(1, remainingMs / rules.graceWindowMs),
    }
  }
  return { kind: driving && round ? 'open' : 'idle', leader }
}
