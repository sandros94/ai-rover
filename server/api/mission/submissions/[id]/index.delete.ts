import { getValidatedRouterParams } from 'nitro/h3'
import { withdrawSubmission } from '../../../../repositories/submissions'
import { useDB } from '../../../../utils/db'
import { defineMissionHandler } from '../../../../utils/mission/http'
import { BAD_INPUT, SubmissionParams } from '../../../../utils/mission/validation'

/** Withdraws the caller's own open submission. */
export default defineMissionHandler({ access: 'write', cache: 'none' }, async (event) => {
  const userId = (await requireUserSession(event)).user.id
  const { id } = await getValidatedRouterParams(event, SubmissionParams, BAD_INPUT)
  return withdrawSubmission(useDB(), id, { userId })
})
