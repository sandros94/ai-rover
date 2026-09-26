import { getValidatedRouterParams } from 'nitro/h3'
import { countLikes, unlike } from '../../../../repositories/likes'
import { useDB } from '../../../../utils/db'
import { defineMissionHandler } from '../../../../utils/mission/http'
import { assertNotPaused } from '../../../../utils/mission/pause'
import { BAD_INPUT, SubmissionParams } from '../../../../utils/mission/validation'

/** Retracts an LGTM while the submission is open; idempotent. Refused while the mission is paused. */
export default defineMissionHandler(
  { access: 'write', cache: 'none' },
  async (event, { missionId }) => {
    const userId = (await requireUserSession(event)).user.id
    const { id } = await getValidatedRouterParams(event, SubmissionParams, BAD_INPUT)
    await assertNotPaused(useDB(), missionId)
    await unlike(useDB(), id, { userId })
    return { submissionId: id, likes: await countLikes(useDB(), id) }
  },
)
