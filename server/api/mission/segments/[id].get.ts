import { getValidatedRouterParams } from 'nitro/h3'
import { useDB } from '../../../utils/db'
import { defineMissionHandler } from '../../../utils/mission/http'
import { journeyDrive } from '../../../utils/mission/journey'
import { BAD_INPUT, SegmentParams } from '../../../utils/mission/validation'

/** One settled drive to replay; 404 while it is still driving. */
export default defineMissionHandler(
  { access: 'read', cache: 'none' },
  async (event, { missionId }) => {
    const { id } = await getValidatedRouterParams(event, SegmentParams, BAD_INPUT)
    return journeyDrive(useDB(), { missionId, segmentId: id })
  },
)
