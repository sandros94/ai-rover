import { getValidatedRouterParams } from 'nitro/h3'
import { getMission } from '../../../../repositories/missions'
import { getOpenRound } from '../../../../repositories/rounds'
import { useDB } from '../../../../utils/db'
import { defineMissionHandler } from '../../../../utils/mission/http'
import { flagNotMoving, notMovingStanding } from '../../../../utils/mission/not-moving'
import { tickMission } from '../../../../utils/mission/tick'
import { BAD_INPUT, SegmentParams } from '../../../../utils/mission/validation'

/**
 * Flags the drive in progress as "rover not moving"; idempotent, a second flag counting from
 * now. The mission is ticked again once the flag is in, so a flag that completes the quorum
 * takes effect at once.
 */
export default defineMissionHandler(
  { access: 'write', cache: 'none', user: true },
  async (event, { missionId, store, jev, now, user }) => {
    const { id } = await getValidatedRouterParams(event, SegmentParams, BAD_INPUT)
    await flagNotMoving(useDB(), { missionId, segmentId: id, userId: user.id, now })
    await tickMission(useDB(), { store, jev, missionId, now })
    const { config } = await getMission(useDB(), missionId)
    const round = await getOpenRound(useDB(), missionId)
    const standing = await notMovingStanding(useDB(), {
      segmentId: id,
      roundId: round?.id ?? null,
      rules: config.rules,
      now,
    })
    return { segmentId: id, ...standing, mine: true }
  },
)
