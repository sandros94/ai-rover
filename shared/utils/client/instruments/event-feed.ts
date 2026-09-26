import type { DriveEvent, DriveEventType } from '../../drive/segment'

export interface FeedItem {
  /** Stable across renders: the event's index. */
  key: string
  type: DriveEventType
  /** Sim time of the event. */
  t: number
  /** `now − t`, seconds. */
  ageS: number
  details?: DriveEvent['details']
}

/** Events newest first, one item each, with their age at sim time `now`. */
export function feedItems(events: readonly DriveEvent[], now: number): FeedItem[] {
  return events
    .map((event, index): FeedItem => ({
      key: String(index),
      type: event.type,
      t: event.t,
      ageS: now - event.t,
      ...(event.details && { details: event.details }),
    }))
    .reverse()
}
