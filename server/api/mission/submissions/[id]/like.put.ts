import { getValidatedRouterParams } from 'nitro/h3'
import { countLikes, like } from '../../../../repositories/likes'
import { useDB } from '../../../../utils/db'
import { defineMissionHandler } from '../../../../utils/mission/http'
import { BAD_INPUT, SubmissionParams } from '../../../../utils/mission/validation'

/** Likes an open submission; idempotent. */
export default defineMissionHandler({ access: 'write', cache: 'none' }, async (event) => {
  const userId = (await requireUserSession(event)).user.id
  const { id } = await getValidatedRouterParams(event, SubmissionParams, BAD_INPUT)
  await like(useDB(), id, { userId })
  return { submissionId: id, likes: await countLikes(useDB(), id) }
})
