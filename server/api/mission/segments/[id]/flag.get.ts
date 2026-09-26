import { getValidatedRouterParams } from 'nitro/h3'
import { getMission } from '../../../../repositories/missions'
import { useDB } from '../../../../utils/db'
import { defineMissionHandler } from '../../../../utils/mission/http'
import { hasNotMovingFlag } from '../../../../utils/mission/not-moving'
import { BAD_INPUT, SegmentParams } from '../../../../utils/mission/validation'

/**
 * Whether the signed-in user's "rover not moving" flag on the segment counts now. Kept apart
 * from the public mission state, which carries the count and quorum and is the same for everyone.
 */
export default defineMissionHandler(
  { access: 'read', cache: 'none' },
  async (event, { missionId, now }) => {
    const userId = (await requireUserSession(event)).user.id
    const { id } = await getValidatedRouterParams(event, SegmentParams, BAD_INPUT)
    const { config } = await getMission(useDB(), missionId)
    const mine = await hasNotMovingFlag(useDB(), {
      segmentId: id,
      userId,
      rules: config.rules,
      now,
    })
    return { segmentId: id, mine }
  },
)
