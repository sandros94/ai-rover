import { useDB } from '../../utils/db'
import { defineMissionHandler } from '../../utils/mission/http'
import { publicMissionState } from '../../utils/mission/state'

/**
 * The current mission as anyone may see it, brought up to date when something is due; the same
 * for everyone, so browsers and the CDN keep it a few seconds and a change purges it.
 */
export default defineMissionHandler(
  { access: 'read', cache: 'public' },
  (_event, { missionId, now }) => publicMissionState(useDB(), { missionId, now }),
)
