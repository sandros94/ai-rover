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

  it('lists every event, stops included, one item each', () => {
    const items = feedItems(
      [
        at(0, 'start'),
        at(0, 'turning'),
        at(757, 'imaging'),
        at(800, 'slip'),
        at(900, 'assessing'),
        at(920, 'replan'),
        at(1000, 'arrived'),
      ],
      1000,
    )
    expect(items.map((i) => [i.key, i.type, i.t])).toEqual([
      ['6', 'arrived', 1000],
      ['5', 'replan', 920],
      ['4', 'assessing', 900],
      ['3', 'slip', 800],
      ['2', 'imaging', 757],
      ['1', 'turning', 0],
      ['0', 'start', 0],
    ])
  })
})
