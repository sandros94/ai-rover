import { describe, expect, it } from 'vitest'
import type { DriveEvent } from '#shared/utils/drive'
import { endingOf, statusAt, statusInForce, statusRuns } from '#shared/utils/drive'

const ev = (t: number, type: DriveEvent['type'], details?: DriveEvent['details']): DriveEvent => ({
  t,
  type,
  x: 0,
  y: 0,
  ...(details && { details }),
})

describe('statusRuns', () => {
  it('is empty before the drive starts', () => {
    expect(statusRuns([])).toEqual([])
    expect(statusAt([], 10)).toEqual({ status: 'stopped', t: 0 })
  })

  it('drives between timed stops and stops for good at a terminal event', () => {
    const runs = statusRuns([
      ev(0, 'start'),
      ev(0, 'turning', { angleDeg: 35, durationS: 35 / 3 }),
      ev(100, 'slip', { slip: 0.4 }),
      ev(757.5, 'imaging', { durationS: 30 }),
      ev(900, 'assessing', { durationS: 20, cause: 'revealed' }),
      ev(920, 'replan', { cause: 'revealed' }),
      ev(920, 'turning', { angleDeg: -60, durationS: 20 }),
      ev(1000, 'arrived'),
    ])
    expect(runs).toEqual([
      { t: 0, status: 'turning', endsAt: 35 / 3, angleDeg: 35 },
      { t: 35 / 3, status: 'driving' },
      { t: 757.5, status: 'imaging', endsAt: 787.5 },
      { t: 787.5, status: 'driving' },
      { t: 900, status: 'assessing', endsAt: 920 },
      { t: 920, status: 'turning', endsAt: 940, angleDeg: -60 },
      { t: 940, status: 'driving' },
      { t: 1000, status: 'stopped' },
    ])
  })

  it('steers before a turn in place and after it, straight into the next run', () => {
    const runs = statusRuns([
      ev(0, 'start'),
      ev(0, 'steering', { durationS: 5 }),
      ev(5, 'turning', { angleDeg: 90, durationS: 60 }),
      ev(65, 'steering', { durationS: 5 }),
      ev(100, 'arrived'),
    ])
    expect(runs).toEqual([
      { t: 0, status: 'steering', endsAt: 5 },
      { t: 5, status: 'turning', endsAt: 65, angleDeg: 90 },
      { t: 65, status: 'steering', endsAt: 70 },
      { t: 70, status: 'driving' },
      { t: 100, status: 'stopped' },
    ])
  })

  it('lets a terminal event cut a stop short', () => {
    const runs = statusRuns([
      ev(0, 'start'),
      ev(0, 'turning', { angleDeg: 90, durationS: 30 }),
      ev(10, 'hazard'),
    ])
    expect(runs).toEqual([
      { t: 0, status: 'turning', endsAt: 30, angleDeg: 90 },
      { t: 10, status: 'stopped' },
    ])
  })
})

describe('statusAt', () => {
  const events = [
    ev(0, 'start'),
    ev(50, 'imaging', { durationS: 30 }),
    ev(200, 'blocked', { reasons: ['goal-unreachable'] }),
  ]

  it('reads the run holding t, the run starting at t included', () => {
    expect(statusAt(events, 0)).toEqual({ t: 0, status: 'driving' })
    expect(statusAt(events, 50)).toEqual({ t: 50, status: 'imaging', endsAt: 80 })
    expect(statusAt(events, 79.9).status).toBe('imaging')
    expect(statusAt(events, 80)).toEqual({ t: 80, status: 'driving' })
    expect(statusAt(events, 500)).toEqual({ t: 200, status: 'stopped' })
  })

  it('works on the events released so far: a stop still running reads as that stop', () => {
    expect(statusAt(events.slice(0, 2), 60).status).toBe('imaging')
    expect(statusAt(events.slice(0, 2), 120).status).toBe('driving')
  })
})

describe('statusInForce and a track begun mid-drive', () => {
  const events = [
    ev(0, 'start'),
    ev(0, 'turning', { angleDeg: 35, durationS: 12 }),
    ev(50, 'imaging', { durationS: 30 }),
    ev(64, 'slip', { slip: 0.4 }),
    ev(95, 'steering', { durationS: 4 }),
    ev(95, 'turning', { angleDeg: -20, durationS: 8 }),
    ev(200, 'blocked', { reasons: ['goal-unreachable'] }),
  ]

  it('is null before the start, then the run the earlier events leave at t', () => {
    expect(statusInForce([], 0)).toBeNull()
    const before = (t: number) => events.filter((e) => e.t < t)
    expect(statusInForce(before(60), 60)).toEqual({ t: 50, status: 'imaging', endsAt: 80 })
    expect(statusInForce(before(90), 90)).toEqual({ t: 80, status: 'driving' })
    expect(statusInForce(before(250), 250)).toEqual({ t: 200, status: 'stopped' })
  })

  it('continues from the run in force exactly as the whole track does', () => {
    for (const cut of [1, 30, 60, 90, 95, 97, 150, 210]) {
      const since = statusInForce(
        events.filter((e) => e.t < cut),
        cut,
      )
      const rest = events.filter((e) => e.t >= cut)
      for (const t of [cut, cut + 1, 79.9, 80, 96, 99, 103, 104, 199, 200, 300]) {
        if (t < cut) continue
        expect(statusAt(rest, t, since), `cut ${cut}, t ${t}`).toEqual(statusAt(events, t))
      }
    }
  })
})

describe('endingOf', () => {
  it('names the terminal event of a stopped run, and nothing for any other run', () => {
    const events = [ev(0, 'start'), ev(40, 'slip', { slip: 0.7 }), ev(40, 'stuck')]
    expect(endingOf(events, statusAt(events, 50))).toBe('stuck')
    expect(endingOf(events, statusAt(events, 20))).toBeUndefined()
    // The ending lies before the events given: the run in force says stopped, nothing says why.
    expect(endingOf([], { t: 40, status: 'stopped' })).toBeUndefined()
  })
})
