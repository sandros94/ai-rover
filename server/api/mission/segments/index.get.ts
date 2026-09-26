import { getQuery } from 'nitro/h3'
import { useDB } from '../../../utils/db'
import { defineMissionHandler } from '../../../utils/mission/http'
import { journeyPage, parseJourneyPage } from '../../../utils/mission/journey'

/** The journey log: settled drives, newest first, `?page=` of fifty. */
export default defineMissionHandler((event, { missionId }) =>
  journeyPage(useDB(), { missionId, page: parseJourneyPage(getQuery(event).page) }),
)
