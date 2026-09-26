import { getQuery } from 'nitro/h3'
import { useDB } from '../../../utils/db'
import { defineMissionHandler } from '../../../utils/mission/http'
import { journeyPage, parseJourneyPage, parseJourneyRange } from '../../../utils/mission/journey'

/**
 * The journey log: settled drives, newest first, `?page=` of fifty. With `?from=&to=` (segment
 * numbers) or `?since=` (an ISO instant the drives ended after), the range oldest first, as a
 * playlist plays it.
 */
export default defineMissionHandler({ access: 'read', cache: 'none' }, (event, { missionId }) => {
  const query = getQuery(event)
  return journeyPage(useDB(), {
    missionId,
    page: parseJourneyPage(query.page),
    range: parseJourneyRange(query),
  })
})
