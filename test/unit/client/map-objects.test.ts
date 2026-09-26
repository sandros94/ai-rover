import { describe, expect, it } from 'vitest'
import type { MapObject, MapObjectsSource } from '#shared/utils/client'
import {
  easeFocus,
  FOCUS_EASE_MS,
  goalBearing,
  hitMapObject,
  HIT_TOLERANCE_PX,
  mapObjects,
  replayedStopsAndDeaths,
  roverObject,
  roverStatus,
  sameMapObject,
} from '#shared/utils/client'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments'

const EPOCH = '2026-09-01T00:00:00.000Z'
/** One sol and a quarter after the epoch: sol 1, 06:00:00 LMST. */
const SOL_1_0600 = new Date(Date.parse(EPOCH) + 1.25 * MARS_SOL_SECONDS * 1000).toISOString()

const ADA = { id: 'u-ada', displayName: 'Ada', avatarUrl: null }

function source(overrides: Partial<MapObjectsSource> = {}): MapObjectsSource {
  return {
    mission: { solsEpoch: EPOCH },
    currentStop: { index: 2 },
    trail: [
      { index: 0, x: 0, y: 0, reachedBy: null },
      {
        index: 1,
        x: 40,
        y: 0,
        reachedBy: { segmentId: 'seg-1', number: 1, fromIndex: 0, at: SOL_1_0600 },
      },
      {
        index: 2,
        x: 80,
        y: 30,
        reachedBy: { segmentId: 'seg-3', number: 3, fromIndex: 1, at: '2026-09-03T00:00:00.000Z' },
      },
    ],
    deaths: [
      {
        x: 50,
        y: -20,
        segmentId: 'seg-2',
        number: 2,
        fromIndex: 1,
        reasons: ['stuck'],
        at: SOL_1_0600,
        distanceM: 23.5,
      },
    ],
    round: {
      anchor: { x: 80, y: 30 },
      submissions: [
        {
          id: 'sub-1',
          goal: { x: 110, y: 60 },
          likes: 4,
          submitter: ADA,
          judgment: { verdict: 'review', risk: 0.9 },
        },
      ],
    },
    ...overrides,
  }
}

const byKind = (objects: MapObject[], kind: MapObject['kind']) =>
  objects.filter((o) => o.kind === kind)

describe('mapObjects', () => {
  it('builds a stop per trail entry: index, when it was reached, by which segment', () => {
    const stops = byKind(mapObjects(source()), 'stop')
    expect(stops.map((s) => s.id)).toEqual(['stop:0', 'stop:1', 'stop:2'])
    expect(stops[0]).toMatchObject({ index: 0, x: 0, y: 0, reached: null, current: false })
    expect(stops[1]).toMatchObject({
      kind: 'stop',
      index: 1,
      x: 40,
      y: 0,
      current: false,
      reached: { segmentId: 'seg-1', number: 1, at: { iso: SOL_1_0600, sol: 1, lmst: '06:00:00' } },
    })
    expect(stops[2]).toMatchObject({ index: 2, current: true })
  })

  it('lists the segments that left each stop, whatever became of them', () => {
    const stops = byKind(mapObjects(source()), 'stop')
    expect(stops[0]).toMatchObject({ departures: [{ segmentId: 'seg-1', number: 1, toIndex: 1 }] })
    expect(stops[1]).toMatchObject({
      departures: [
        { segmentId: 'seg-2', number: 2, toIndex: null },
        { segmentId: 'seg-3', number: 3, toIndex: 2 },
      ],
    })
    expect(stops[2]).toMatchObject({ departures: [] })
  })

  it('builds a death per settled failure: segment, reasons, when and distance driven', () => {
    const [death] = byKind(mapObjects(source()), 'death')
    expect(death).toEqual({
      kind: 'death',
      id: 'death:seg-2',
      x: 50,
      y: -20,
      segmentId: 'seg-2',
      number: 2,
      fromIndex: 1,
      reasons: ['stuck'],
      at: { iso: SOL_1_0600, sol: 1, lmst: '06:00:00' },
      distanceM: 23.5,
    })
  })

  it("builds a submission per open round entry at its goal: author, distance and bearing from the round's anchor, verdict, risk, LGTMs", () => {
    const [submission] = byKind(mapObjects(source()), 'submission')
    expect(submission).toEqual({
      kind: 'submission',
      id: 'submission:sub-1',
      submissionId: 'sub-1',
      x: 110,
      y: 60,
      author: { displayName: 'Ada', avatarUrl: null },
      distanceM: Math.hypot(30, 30),
      bearing: { degrees: 45, compass: 'NE' },
      verdict: 'review',
      risk: 0.9,
      likes: 4,
    })
  })

  it('has no submissions without an open round', () => {
    expect(byKind(mapObjects(source({ round: null })), 'submission')).toEqual([])
  })

  it('reads dates given as Date objects as well as ISO strings', () => {
    const [death] = byKind(
      mapObjects(
        source({
          mission: { solsEpoch: new Date(EPOCH) },
          deaths: [{ ...source().deaths[0]!, at: new Date(SOL_1_0600) }],
        }),
      ),
      'death',
    )
    expect(death).toMatchObject({ at: { iso: SOL_1_0600, sol: 1, lmst: '06:00:00' } })
  })
})

describe('replayedStopsAndDeaths', () => {
  const BEFORE: Pick<MapObjectsSource, 'trail' | 'deaths'> = {
    trail: [{ index: 0, x: 0, y: 0, reachedBy: null }],
    deaths: [],
  }
  const DRIVES = [
    {
      id: 'd1',
      number: 1,
      endedAt: '2026-09-02T00:00:00.000Z',
      distanceM: 80,
      reasons: [],
      from: { index: 0 },
      to: { index: 1, x: 0, y: 80 },
      death: null,
    },
    {
      id: 'd2',
      number: 2,
      endedAt: '2026-09-03T00:00:00.000Z',
      distanceM: 41.6,
      reasons: ['stuck'],
      from: { index: 1 },
      to: null,
      death: { x: 30, y: 100 },
    },
  ]

  it('adds a stop once the drive that reached it has played, with who reached it and when', () => {
    expect(replayedStopsAndDeaths(BEFORE, DRIVES, 0)).toEqual(BEFORE)
    const second = replayedStopsAndDeaths(BEFORE, DRIVES, 1)
    expect(second.trail).toEqual([
      { index: 0, x: 0, y: 0, reachedBy: null },
      {
        index: 1,
        x: 0,
        y: 80,
        reachedBy: { segmentId: 'd1', number: 1, fromIndex: 0, at: '2026-09-02T00:00:00.000Z' },
      },
    ])
  })

  it('shows the death of every drive up to the one playing, as the live map describes it', () => {
    const [death] = replayedStopsAndDeaths(BEFORE, DRIVES, 1).deaths
    expect(death).toEqual({
      x: 30,
      y: 100,
      segmentId: 'd2',
      number: 2,
      fromIndex: 1,
      reasons: ['stuck'],
      at: '2026-09-03T00:00:00.000Z',
      distanceM: 41.6,
    })
    const [object] = byKind(
      mapObjects({
        mission: { solsEpoch: EPOCH },
        currentStop: { index: 1 },
        ...replayedStopsAndDeaths(BEFORE, DRIVES, 1),
        round: null,
      }),
      'death',
    )
    expect(object).toMatchObject({ id: 'death:d2', number: 2, fromIndex: 1, distanceM: 41.6 })
  })
})

describe('mapObjects with a departing drive', () => {
  it("lists a replay's playing drive among its stop's departures, once", () => {
    const base = {
      mission: { solsEpoch: EPOCH },
      currentStop: { index: 0 },
      trail: [{ index: 0, x: 0, y: 0, reachedBy: null }],
      deaths: [],
      round: null,
    }
    const departing = { segmentId: 'd1', number: 1, fromIndex: 0, toIndex: 1 }
    const [stop] = byKind(mapObjects({ ...base, departing }), 'stop')
    expect(stop).toMatchObject({ departures: [{ segmentId: 'd1', number: 1, toIndex: 1 }] })
    // A failed one is already listed through its death.
    const death = {
      x: 5,
      y: 5,
      segmentId: 'd1',
      number: 1,
      fromIndex: 0,
      reasons: ['stuck'],
      at: EPOCH,
      distanceM: 3,
    }
    const [lost] = byKind(
      mapObjects({ ...base, deaths: [death], departing: { ...departing, toIndex: null } }),
      'stop',
    )
    expect(lost).toMatchObject({ departures: [{ segmentId: 'd1', number: 1, toIndex: null }] })
  })
})

describe('roverObject and roverStatus', () => {
  it('places the rover with its status, speed and segment progress', () => {
    expect(
      roverObject(
        { x: 3, y: 4, headingRad: 1 },
        { status: 'driving', speedMps: 0.04, progress: 0.25 },
      ),
    ).toEqual({
      kind: 'rover',
      id: 'rover',
      x: 3,
      y: 4,
      headingRad: 1,
      status: 'driving',
      speedMps: 0.04,
      progress: 0.25,
    })
  })

  it('says driving while a drive plays, planning once a pick waits, else waiting', () => {
    const round = { closesAt: null }
    expect(roverStatus({ segment: { id: 's' }, round })).toBe('driving')
    expect(roverStatus({ segment: null, round: { closesAt: '2026-09-26T10:00:00Z' } })).toBe(
      'planning',
    )
    expect(roverStatus({ segment: null, round })).toBe('waiting')
    expect(roverStatus({ segment: null, round: null })).toBe('waiting')
  })
})

describe('goalBearing', () => {
  it('measures clockwise from north with an eight-point compass', () => {
    expect(goalBearing({ x: 0, y: 0 }, { x: 0, y: 10 })).toEqual({
      distanceM: 10,
      degrees: 0,
      compass: 'N',
    })
    expect(goalBearing({ x: 0, y: 0 }, { x: -10, y: 0 })).toMatchObject({
      degrees: 270,
      compass: 'W',
    })
    expect(goalBearing({ x: 5, y: 5 }, { x: 5 + 3, y: 5 - 3 })).toMatchObject({
      degrees: 135,
      compass: 'SE',
    })
  })
})

describe('hitMapObject', () => {
  const stop = { kind: 'stop', id: 'stop:0', x: 0, y: 0 } as const
  const death = { kind: 'death', id: 'death:a', x: 2, y: 0 } as const
  const submission = { kind: 'submission', id: 'submission:a', x: 1, y: 1 } as const
  const rover = { kind: 'rover', id: 'rover', x: 0.5, y: 0.5 } as const

  it('takes 12 px of tolerance, measured in world metres through the map scale', () => {
    expect(HIT_TOLERANCE_PX).toBe(12)
    // At 4 px per metre the tolerance is 3 m.
    const toleranceM = HIT_TOLERANCE_PX / 4
    expect(hitMapObject([stop], { x: 2.9, y: 0 }, { toleranceM })).toBe(stop)
    expect(hitMapObject([stop], { x: 0, y: -3 }, { toleranceM })).toBe(stop)
    expect(hitMapObject([stop], { x: 3.1, y: 0 }, { toleranceM })).toBeUndefined()
    expect(hitMapObject([stop], { x: 2.2, y: 2.2 }, { toleranceM })).toBeUndefined()
  })

  it('prefers the rover, then a submission, then a death, then a stop when they overlap', () => {
    const toleranceM = 5
    const at = { x: 0, y: 0 }
    expect(hitMapObject([stop, death, submission, rover], at, { toleranceM })).toBe(rover)
    expect(hitMapObject([stop, death, submission], at, { toleranceM })).toBe(submission)
    expect(hitMapObject([stop, death], at, { toleranceM })).toBe(death)
    expect(hitMapObject([stop], at, { toleranceM })).toBe(stop)
  })

  it('takes the nearest of one kind', () => {
    const far = { kind: 'stop', id: 'stop:1', x: 2, y: 0 } as const
    expect(hitMapObject([far, stop], { x: 0.4, y: 0 }, { toleranceM: 3 })).toBe(stop)
    expect(hitMapObject([stop, far], { x: 1.6, y: 0 }, { toleranceM: 3 })).toBe(far)
  })

  it('finds nothing in an empty map', () => {
    expect(hitMapObject([], { x: 0, y: 0 }, { toleranceM: 3 })).toBeUndefined()
  })
})

describe('sameMapObject', () => {
  it('compares by id, null matching nothing', () => {
    expect(sameMapObject({ id: 'stop:1' }, { id: 'stop:1' })).toBe(true)
    expect(sameMapObject({ id: 'stop:1' }, { id: 'death:1' })).toBe(false)
    expect(sameMapObject(null, { id: 'stop:1' })).toBe(false)
    expect(sameMapObject(null, null)).toBe(false)
  })
})

describe('easeFocus', () => {
  const from = { x: 0, y: 0, z: 0 }
  const to = { x: 10, y: -20, z: 4 }

  it('starts at the old target, ends at the new one, eased in and out', () => {
    expect(easeFocus(from, to, 0)).toEqual(from)
    expect(easeFocus(from, to, FOCUS_EASE_MS)).toEqual(to)
    expect(easeFocus(from, to, 10 * FOCUS_EASE_MS)).toEqual(to)
    const half = easeFocus(from, to, FOCUS_EASE_MS / 2)
    expect(half.x).toBeCloseTo(5, 9)
    expect(half.y).toBeCloseTo(-10, 9)
    // Slow at the start: a tenth of the time covers well under a tenth of the way.
    expect(easeFocus(from, to, FOCUS_EASE_MS / 10).x).toBeLessThan(1)
  })
})
