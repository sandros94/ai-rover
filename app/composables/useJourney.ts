/** Narrows the journey log: segment numbers `from` to `to`, drives ended after `since` (ISO). */
export interface JourneyRangeQuery {
  since?: string
  from?: number
  to?: number
}

const fetchJourneyPage = (page: number) => $fetch('/api/mission/segments', { query: { page } })
const fetchJourneyRange = (range: JourneyRangeQuery) =>
  $fetch('/api/mission/segments', { query: range })
const fetchDrive = (segmentId: string) => $fetch(`/api/mission/segments/${segmentId}`)

/** A page of `/api/mission/segments` as it arrives: dates as ISO strings. */
export type JourneyPageJson = Awaited<ReturnType<typeof fetchJourneyPage>>
/** One settled drive as the journey log lists it. */
export type DriveJson = JourneyPageJson['drives'][number]
/** `/api/mission/segments/:id`: a settled drive with what its replay needs. */
export type DriveReplayJson = Awaited<ReturnType<typeof fetchDrive>>

/** What a replay of consecutive settled drives plays: the drives, oldest first, and the mission. */
export interface PlaylistJson {
  drives: DriveJson[]
  /** Drives the range holds in all; more than `drives` when it was cut to a page. */
  total: number
  mission: DriveReplayJson['mission']
  /** The stops reached up to the one the first drive left. */
  trail: DriveReplayJson['trail']
  /** The deaths public when the first drive started. */
  deaths: DriveReplayJson['deaths']
}

/** "Stop 3 → stop 4", or "Stop 3 → lost" for a failure. */
export function driveRoute(drive: Pick<DriveJson, 'from' | 'to'>): string {
  return `Stop ${drive.from.index} → ${drive.to ? `stop ${drive.to.index}` : 'lost'}`
}

/** Page `page` of the journey log, refetched when it changes. */
export function useJourneyPage(page: MaybeRefOrGetter<number>) {
  return useAsyncData('journey-page', () => fetchJourneyPage(toValue(page)), {
    watch: [() => toValue(page)],
  })
}

/** One settled drive for its replay. */
export function useDriveReplay(segmentId: MaybeRefOrGetter<string>) {
  return useAsyncData(`drive-${toValue(segmentId)}`, () => fetchDrive(toValue(segmentId)))
}

/**
 * The settled drives of `range` for a replay, oldest first, at most a page of them; null when
 * the range holds none. The first drive's own record brings the mission, the trail and deaths.
 */
export function useDriveRange(range: MaybeRefOrGetter<JourneyRangeQuery>) {
  return useAsyncData(
    () => `drive-range-${JSON.stringify(toValue(range))}`,
    async (): Promise<PlaylistJson | null> => {
      const { drives, total } = await fetchJourneyRange(toValue(range))
      if (drives.length === 0) return null
      const first = await fetchDrive(drives[0]!.id)
      return { drives, total, mission: first.mission, trail: first.trail, deaths: first.deaths }
    },
  )
}
