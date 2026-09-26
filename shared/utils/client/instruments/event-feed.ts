import type { DriveEvent, DriveEventType } from '../../drive/segment'

export interface FeedItem {
  /** Stable across renders: the index of the item's first event. */
  key: string
  type: DriveEventType
  /** Sim time of the item's latest event. */
  t: number
  /** Sim time of its first event; equals `t` unless pauses were collapsed. */
  firstT: number
  /** `now − t`, seconds. */
  ageS: number
  /** Events the item stands for: more than 1 only for a run of pauses. */
  count: number
  /** Details of the latest event. */
  details?: DriveEvent['details']
}

/** Events newest first, each run of consecutive pauses collapsed into one item. */
export function feedItems(events: readonly DriveEvent[], now: number): FeedItem[] {
  const items: FeedItem[] = []
  events.forEach((event, index) => {
    const last = items.at(-1)
    if (event.type === 'pause' && last?.type === 'pause') {
      last.count++
      last.t = event.t
      last.ageS = now - event.t
      last.details = event.details
      return
    }
    items.push({
      key: String(index),
      type: event.type,
      t: event.t,
      firstT: event.t,
      ageS: now - event.t,
      count: 1,
      ...(event.details && { details: event.details }),
    })
  })
  return items.reverse()
}
