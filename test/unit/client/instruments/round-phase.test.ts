import { describe, expect, it } from 'vitest'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { roundPhase } from '#shared/utils/client/instruments/round-phase'

const NOW = Date.UTC(2026, 8, 26, 12)
const PLANNING = DEFAULT_MISSION_RULES.graceWindowMs

function submission(
  id: string,
  likes: number,
  risk = 1,
  createdAt = NOW - 60_000,
  deferred = false,
  exploration = 0,
) {
  return {
    id,
    likes,
    exploration,
    submitter: { id: `user-${id}` },
    deferred,
    createdAt: new Date(createdAt).toISOString(),
    judgment: { risk, distanceWeight: 0.5, timeWeight: 0.5 },
  }
}

const base = { nowMs: NOW, rules: DEFAULT_MISSION_RULES }

describe('roundPhase', () => {
  it('is idle without a round or while nobody has submitted after the drive', () => {
    expect(roundPhase({ ...base, round: null, driving: false }).kind).toBe('idle')
    expect(
      roundPhase({ ...base, round: { closesAt: null, submissions: [] }, driving: false }).kind,
    ).toBe('idle')
  })

  it('is open with no close time while a drive plays', () => {
    const phase = roundPhase({
      ...base,
      round: { closesAt: null, submissions: [submission('a', 2)] },
      driving: true,
    })
    expect(phase.kind).toBe('open')
    expect(phase.leader).toEqual({ id: 'a', likes: 2 })
  })

  it('counts the planning phase down to the close', () => {
    const phase = roundPhase({
      ...base,
      round: {
        closesAt: new Date(NOW + PLANNING / 4).toISOString(),
        submissions: [submission('a', 0)],
      },
      driving: false,
    })
    expect(phase.kind).toBe('planning')
    if (phase.kind !== 'planning') return
    expect(phase.remainingMs).toBe(PLANNING / 4)
    expect(phase.fraction).toBeCloseTo(0.25, 12)
  })

  it('clamps a passed close to zero', () => {
    const phase = roundPhase({
      ...base,
      round: { closesAt: new Date(NOW - 1000), submissions: [submission('a', 0)] },
      driving: false,
    })
    expect(phase).toMatchObject({ kind: 'planning', remainingMs: 0, fraction: 0 })
  })

  it('names the leader by the ranking score, likes weighed by exploration', () => {
    const phase = roundPhase({
      ...base,
      round: {
        closesAt: null,
        // √3 ≈ 1.73 against √1 × (1 + 1) = 2.
        submissions: [submission('a', 3), submission('c', 1, 1, NOW - 60_000, false, 1)],
      },
      driving: true,
    })
    expect(phase.leader).toEqual({ id: 'c', likes: 1 })
  })

  it('names the leader by likes on equal exploration, then the mission tie-break', () => {
    const phase = roundPhase({
      ...base,
      round: {
        closesAt: null,
        submissions: [submission('a', 3, 2), submission('b', 3, 1), submission('c', 1, 0)],
      },
      driving: true,
    })
    expect(phase.leader).toEqual({ id: 'b', likes: 3 })
  })

  it("puts the driving author's deferred submission behind everyone else's", () => {
    const round = {
      closesAt: null,
      submissions: [submission('author', 5, 0, NOW - 60_000, true), submission('b', 1)],
    }
    expect(roundPhase({ ...base, round, driving: true }).leader).toEqual({ id: 'b', likes: 1 })
    const alone = { closesAt: null, submissions: [round.submissions[0]!] }
    expect(roundPhase({ ...base, round: alone, driving: true }).leader).toEqual({
      id: 'author',
      likes: 5,
    })
  })
})
