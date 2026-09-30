import { describe, expect, it } from 'vitest'
import type { DriveEvent } from '#shared/utils/drive'
import { statusAt, statusRuns } from '#shared/utils/drive'

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
