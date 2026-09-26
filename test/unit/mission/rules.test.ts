import { describe, expect, it } from 'vitest'
import type { MissionRules, RankEntry } from '#shared/utils/mission'
import {
  checkPathClearOfDeaths,
  checkSubmissionGoal,
  DEFAULT_MISSION_RULES,
  MissionError,
  rankSubmissions,
  roundCloseAt,
  shouldResetToPreviousStop,
} from '#shared/utils/mission'

const rules = DEFAULT_MISSION_RULES
const start = { x: 0, y: 0 }

describe('DEFAULT_MISSION_RULES', () => {
  it('carries the documented constants and is frozen', () => {
    expect(rules).toEqual({
      segmentDistanceBand: { minM: 50, maxM: 250 },
      failureZone: { destinationRadiusM: 30, pathRadiusM: 15, clusterRadiusM: 50, strikes: 3 },
      graceWindowMs: 300_000,
      maxJudgedPerRound: 5,
      tieBreak: 'risk',
      notMoving: {
        quorumMax: 5,
        quorumMin: 2,
        windowMs: 600_000,
        progressM: 0.5,
        backstopMs: 900_000,
      },
    })
    expect(Object.isFrozen(rules)).toBe(true)
    expect(Object.isFrozen(rules.failureZone)).toBe(true)
    expect(Object.isFrozen(rules.notMoving)).toBe(true)
  })
})

describe('checkSubmissionGoal', () => {
  const check = (x: number, deaths: { x: number; y: number }[] = []) =>
    checkSubmissionGoal({ x, y: 0 }, { start, deaths, rules })

  it('accepts the band edges inclusively', () => {
    expect(check(50)).toEqual({ ok: true })
    expect(check(250)).toEqual({ ok: true })
  })

  it('refuses just inside the minimum and just past the maximum', () => {
    expect(check(49.999)).toEqual({ ok: false, reason: 'too-near' })
    expect(check(250.001)).toEqual({ ok: false, reason: 'too-far' })
  })

  it('measures the band in the plane, not per axis', () => {
    expect(checkSubmissionGoal({ x: 30, y: 40 }, { start, deaths: [], rules })).toEqual({
      ok: true,
    })
  })

  it('refuses a goal at or within the destination radius of a death', () => {
    expect(check(100, [{ x: 130, y: 0 }])).toEqual({ ok: false, reason: 'near-death-zone' })
    expect(check(100, [{ x: 110, y: 0 }])).toEqual({ ok: false, reason: 'near-death-zone' })
    expect(check(100, [{ x: 130.001, y: 0 }])).toEqual({ ok: true })
  })

  it('reports the distance band before the death zone', () => {
    expect(check(20, [{ x: 20, y: 0 }])).toEqual({ ok: false, reason: 'too-near' })
  })

  it('follows configured rules', () => {
    const tight: MissionRules = { ...rules, segmentDistanceBand: { minM: 10, maxM: 20 } }
    expect(checkSubmissionGoal({ x: 15, y: 0 }, { start, deaths: [], rules: tight })).toEqual({
      ok: true,
    })
  })
})

describe('checkPathClearOfDeaths', () => {
  const polyline = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]

  it('is clear with no deaths', () => {
    expect(checkPathClearOfDeaths(polyline, { deaths: [], rules })).toEqual({
      ok: true,
      nearestM: Infinity,
    })
  })

  it('measures to the nearest segment, not only the vertices', () => {
    const result = checkPathClearOfDeaths(polyline, { deaths: [{ x: 50, y: 20 }], rules })
    expect(result.ok).toBe(true)
    expect(result.nearestM).toBeCloseTo(20, 12)
  })

  it('refuses a death at or within the path radius', () => {
    expect(checkPathClearOfDeaths(polyline, { deaths: [{ x: 50, y: 15 }], rules })).toEqual({
      ok: false,
      nearestM: 15,
    })
    expect(checkPathClearOfDeaths(polyline, { deaths: [{ x: 50, y: 15.001 }], rules }).ok).toBe(
      true,
    )
  })

  it('takes the nearest of several deaths and segments', () => {
    const result = checkPathClearOfDeaths(polyline, {
      deaths: [
        { x: 50, y: 40 },
        { x: 110, y: 50 },
      ],
      rules,
    })
    expect(result).toEqual({ ok: false, nearestM: 10 })
  })

  it('measures beyond the ends to the endpoints', () => {
    const result = checkPathClearOfDeaths(polyline, { deaths: [{ x: -30, y: -40 }], rules })
    expect(result.nearestM).toBeCloseTo(50, 12)
  })

  it('handles a single-point polyline', () => {
    const result = checkPathClearOfDeaths([{ x: 0, y: 0 }], { deaths: [{ x: 3, y: 4 }], rules })
    expect(result).toEqual({ ok: false, nearestM: 5 })
  })

  it('refuses an empty polyline', () => {
    let caught: unknown
    try {
      checkPathClearOfDeaths([], { deaths: [], rules })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MissionError)
    expect((caught as MissionError).code).toBe('INVALID_INPUT')
  })
})

describe('shouldResetToPreviousStop', () => {
  const reset = (deaths: { x: number; y: number }[]) => shouldResetToPreviousStop(deaths, { rules })

  it('resets on three deaths pairwise within the cluster radius', () => {
    expect(
      reset([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 25, y: 40 },
      ]),
    ).toBe(true)
  })

  it('does not reset on two close deaths and one far', () => {
    expect(
      reset([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 200, y: 0 },
      ]),
    ).toBe(false)
  })

  it('needs every pair within the radius, not a chain', () => {
    // 0–40 and 40–80 are within 50 m, 0–80 is not.
    expect(
      reset([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 80, y: 0 },
      ]),
    ).toBe(false)
  })

  it('does not reset below the strike count', () => {
    expect(reset([])).toBe(false)
    expect(
      reset([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBe(false)
  })

  it('finds a cluster among scattered deaths', () => {
    expect(
      reset([
        { x: 500, y: 500 },
        { x: 0, y: 0 },
        { x: -300, y: 0 },
        { x: 30, y: 0 },
        { x: 0, y: 30 },
      ]),
    ).toBe(true)
  })

  it('follows the configured strike count', () => {
    const two: MissionRules = { ...rules, failureZone: { ...rules.failureZone, strikes: 2 } }
    expect(
      shouldResetToPreviousStop(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        { rules: two },
      ),
    ).toBe(true)
  })
})

describe('rankSubmissions', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, s))
  function entry(
    id: string,
    likes: number,
    createdAt: Date,
    weights: { distance: number; time: number; risk: number },
    userId = `user-${id}`,
  ): RankEntry {
    return {
      id,
      userId,
      likes,
      createdAt,
      judgment: {
        distanceWeight: weights.distance,
        timeWeight: weights.time,
        risk: { score: weights.risk },
      },
    }
  }
  const ids = (entries: RankEntry[]) => entries.map((e) => e.id)

  it('ranks by likes first, whatever the tie-break', () => {
    const entries = [
      entry('a', 1, at(0), { distance: 1, time: 1, risk: 0 }),
      entry('b', 3, at(5), { distance: 0, time: 0, risk: 4 }),
    ]
    expect(ids(rankSubmissions(entries, { rules }))).toEqual(['b', 'a'])
    expect(ids(rankSubmissions(entries, { rules: { ...rules, tieBreak: 'confidence' } }))).toEqual([
      'b',
      'a',
    ])
  })

  it("'risk' breaks ties by lower risk, then higher confidence sum, then earlier", () => {
    const entries = [
      entry('high-risk', 2, at(0), { distance: 1, time: 1, risk: 3 }),
      entry('low-risk-late', 2, at(9), { distance: 0.5, time: 0.5, risk: 1 }),
      entry('low-risk-sure', 2, at(9), { distance: 0.9, time: 0.5, risk: 1 }),
      entry('low-risk-early', 2, at(1), { distance: 0.5, time: 0.5, risk: 1 }),
    ]
    expect(ids(rankSubmissions(entries, { rules }))).toEqual([
      'low-risk-sure',
      'low-risk-early',
      'low-risk-late',
      'high-risk',
    ])
  })

  it("'confidence' breaks ties by higher confidence sum, then earlier, ignoring risk", () => {
    const entries = [
      entry('safe-unsure', 2, at(0), { distance: 0.2, time: 0.2, risk: 0 }),
      entry('risky-sure-late', 2, at(9), { distance: 0.9, time: 0.9, risk: 4 }),
      entry('risky-sure-early', 2, at(1), { distance: 0.9, time: 0.9, risk: 4 }),
    ]
    expect(ids(rankSubmissions(entries, { rules: { ...rules, tieBreak: 'confidence' } }))).toEqual([
      'risky-sure-early',
      'risky-sure-late',
      'safe-unsure',
    ])
  })

  it('is deterministic whatever the input order, down to the id', () => {
    const entries = [
      entry('c', 1, at(0), { distance: 0.5, time: 0.5, risk: 1 }),
      entry('a', 1, at(0), { distance: 0.5, time: 0.5, risk: 1 }),
      entry('b', 1, at(0), { distance: 0.5, time: 0.5, risk: 1 }),
      entry('d', 4, at(3), { distance: 0, time: 0, risk: 2 }),
    ]
    const expected = ['d', 'a', 'b', 'c']
    expect(ids(rankSubmissions(entries, { rules }))).toEqual(expected)
    expect(ids(rankSubmissions(entries.toReversed(), { rules }))).toEqual(expected)
  })

  it('ranks the driving author last whatever their LGTMs, others by the usual order', () => {
    const entries = [
      entry('author', 9, at(0), { distance: 1, time: 1, risk: 0 }, 'ada'),
      entry('few', 1, at(5), { distance: 0, time: 0, risk: 4 }, 'bob'),
      entry('more', 2, at(9), { distance: 0, time: 0, risk: 4 }, 'cy'),
    ]
    expect(ids(rankSubmissions(entries, { rules, drivingAuthorId: 'ada' }))).toEqual([
      'more',
      'few',
      'author',
    ])
    // Without a driving author, LGTMs decide as usual.
    expect(ids(rankSubmissions(entries, { rules }))).toEqual(['author', 'more', 'few'])
  })

  it("lets the driving author's submission win when it is the only one", () => {
    const entries = [entry('author', 1, at(0), { distance: 1, time: 1, risk: 0 }, 'ada')]
    expect(ids(rankSubmissions(entries, { rules, drivingAuthorId: 'ada' }))).toEqual(['author'])
  })

  it('returns a new array and leaves the input alone', () => {
    const entries = [
      entry('a', 0, at(0), { distance: 0, time: 0, risk: 0 }),
      entry('b', 1, at(0), { distance: 0, time: 0, risk: 0 }),
    ]
    const ranked = rankSubmissions(entries, { rules })
    expect(ranked).not.toBe(entries)
    expect(ids(entries)).toEqual(['a', 'b'])
  })
})

describe('roundCloseAt', () => {
  const t0 = new Date('2026-09-25T12:00:00Z')
  const plus = (ms: number) => new Date(t0.getTime() + ms)

  it('closes at the drive end while the drive plays', () => {
    expect(
      roundCloseAt({ driveEndsAt: plus(60_000), firstSubmissionAt: null, now: t0, rules }),
    ).toEqual(plus(60_000))
    expect(
      roundCloseAt({ driveEndsAt: plus(60_000), firstSubmissionAt: t0, now: t0, rules }),
    ).toEqual(plus(60_000))
  })

  it('closes at the drive end when a submission was waiting then', () => {
    expect(
      roundCloseAt({
        driveEndsAt: plus(60_000),
        firstSubmissionAt: plus(60_000),
        now: plus(120_000),
        rules,
      }),
    ).toEqual(plus(60_000))
  })

  it('opens the grace window at the first submission after the drive ended', () => {
    expect(
      roundCloseAt({
        driveEndsAt: t0,
        firstSubmissionAt: plus(1),
        now: plus(10),
        rules,
      }),
    ).toEqual(plus(1 + 300_000))
  })

  it('opens the grace window at the first submission when no drive exists', () => {
    expect(roundCloseAt({ driveEndsAt: null, firstSubmissionAt: t0, now: plus(5), rules })).toEqual(
      plus(300_000),
    )
  })

  it('is null while nothing is pending', () => {
    expect(roundCloseAt({ driveEndsAt: null, firstSubmissionAt: null, now: t0, rules })).toBe(null)
    expect(roundCloseAt({ driveEndsAt: t0, firstSubmissionAt: null, now: plus(1), rules })).toBe(
      null,
    )
  })

  it('follows the configured grace window', () => {
    expect(
      roundCloseAt({
        driveEndsAt: null,
        firstSubmissionAt: t0,
        now: t0,
        rules: { ...rules, graceWindowMs: 1000 },
      }),
    ).toEqual(plus(1000))
  })
})
