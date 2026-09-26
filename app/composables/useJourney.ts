const fetchJourneyPage = (page: number) => $fetch('/api/mission/segments', { query: { page } })
const fetchDrive = (segmentId: string) => $fetch(`/api/mission/segments/${segmentId}`)

/** A page of `/api/mission/segments` as it arrives: dates as ISO strings. */
export type JourneyPageJson = Awaited<ReturnType<typeof fetchJourneyPage>>
/** One settled drive as the journey log lists it. */
export type DriveJson = JourneyPageJson['drives'][number]
/** `/api/mission/segments/:id`: a settled drive with what its replay needs. */
export type DriveReplayJson = Awaited<ReturnType<typeof fetchDrive>>

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
