import { describe, expect, it } from 'vitest'
import type { DriveEvent } from '#shared/utils/drive'
import { feedItems } from '#shared/utils/client/instruments/event-feed'

const at = (t: number, type: DriveEvent['type']): DriveEvent => ({ t, type, x: 0, y: 0 })

describe('feedItems', () => {
  it('lists newest first with the age at `now`', () => {
    const items = feedItems([at(0, 'start'), at(40, 'replan')], 100)
    expect(items.map((i) => [i.type, i.ageS])).toEqual([
      ['replan', 60],
      ['start', 100],
    ])
  })

  it('collapses a run of pauses into one item with its count', () => {
    const items = feedItems(
      [
        at(0, 'start'),
        at(30, 'pause'),
        at(60, 'pause'),
        at(70, 'slip'),
        at(90, 'pause'),
        at(120, 'pause'),
        at(150, 'pause'),
      ],
      160,
    )
    expect(items.map((i) => [i.type, i.count, i.t])).toEqual([
      ['pause', 3, 150],
      ['slip', 1, 70],
      ['pause', 2, 60],
      ['start', 1, 0],
    ])
    expect(items[0]!.firstT).toBe(90)
  })

  it('keeps each item keyed by its first event', () => {
    const items = feedItems([at(0, 'start'), at(30, 'pause'), at(60, 'pause')], 60)
    expect(items.map((i) => i.key)).toEqual(['1', '0'])
  })
})
