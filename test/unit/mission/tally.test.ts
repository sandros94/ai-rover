import { describe, expect, it } from 'vitest'
import type { SettledSegment } from '#server/utils/mission/state'
import { journeyTally } from '#server/utils/mission/state'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'

const rules = DEFAULT_MISSION_RULES
const landing = { id: 's0', fromSegmentId: null }

function segment(
  status: SettledSegment['status'],
  fromStopId: string,
  distanceM: number,
  death: { x: number; y: number } | null = null,
): Pick<SettledSegment, 'status' | 'fromStopId' | 'distanceM' | 'death'> {
  return { status, fromStopId, distanceM, death }
}

describe('journeyTally', () => {
  it('is zero but for the landing stop before any drive has settled', () => {
    expect(journeyTally([], { stops: [landing], rules })).toEqual({
      distanceM: 0,
      stops: 1,
      arrived: 0,
      stoppedShort: 0,
      failed: 0,
      resets: 0,
      longestM: 0,
    })
  })

  it('counts outcomes, sums the distance of every settled drive and keeps the longest', () => {
    const stops = [landing, { id: 's1', fromSegmentId: 'a' }, { id: 's2', fromSegmentId: 'b' }]
    const tally = journeyTally(
      [
        segment('arrived', 's0', 120.5),
        segment('stopped-short', 's1', 60.25),
        segment('failed', 's2', 210, { x: 5, y: 5 }),
      ],
      { stops, rules },
    )
    expect(tally).toEqual({
      distanceM: 390.75,
      stops: 3,
      arrived: 1,
      stoppedShort: 1,
      failed: 1,
      resets: 0,
      longestM: 210,
    })
  })

  it('counts a reset once the failures from a reached stop cluster, as the tick applies it', () => {
    const stops = [landing, { id: 's1', fromSegmentId: 'a' }]
    const deaths = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]
    const two = [
      segment('arrived', 's0', 80),
      ...deaths.slice(0, 2).map((d) => segment('failed', 's1', 20, d)),
    ]
    expect(journeyTally(two, { stops, rules }).resets).toBe(0)
    const three = [...two, segment('failed', 's1', 20, deaths[2]!)]
    expect(journeyTally(three, { stops, rules })).toMatchObject({ failed: 3, resets: 1 })
  })

  it('never resets from the landing stop, and scattered deaths do not cluster', () => {
    const stops = [landing, { id: 's1', fromSegmentId: 'a' }]
    const clustered = [0, 1, 2].map((k) => segment('failed', 's0', 5, { x: k, y: 0 }))
    expect(journeyTally(clustered, { stops, rules }).resets).toBe(0)
    const scattered = [
      segment('arrived', 's0', 80),
      ...[0, 100, 200].map((x) => segment('failed', 's1', 5, { x, y: 0 })),
    ]
    expect(journeyTally(scattered, { stops, rules }).resets).toBe(0)
  })
})
