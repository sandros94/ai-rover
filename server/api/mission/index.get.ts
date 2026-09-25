import { useDB } from '../../utils/db'
import { defineMissionHandler } from '../../utils/mission/http'
import { publicMissionState } from '../../utils/mission/state'

/** The current mission as anyone may see it, brought up to date first. */
export default defineMissionHandler((_event, { missionId, now }) =>
  publicMissionState(useDB(), { missionId, now }),
)
