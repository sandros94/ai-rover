import { HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { requireUserId } from '../../../utils/auth-shim'
import { useDB } from '../../../utils/db'
import { useJevClient } from '../../../utils/jev'
import { defineMissionHandler } from '../../../utils/mission/http'
import { submitGoal } from '../../../utils/mission/submit'
import { BAD_INPUT } from '../../../utils/mission/validation'

const finite = v.pipe(v.number(), v.finite())
const BodySchema = v.object({ goal: v.object({ x: finite, y: finite }) })

/** Submits a goal; a refused one answers 422 with its reason (and the stored rejection, if any). */
export default defineMissionHandler(async (event, { missionId, store, now }) => {
  const userId = await requireUserId(event)
  const { goal } = await readValidatedBody(event, BodySchema, BAD_INPUT)
  const result = await submitGoal(useDB(), {
    store,
    jev: useJevClient(),
    missionId,
    userId,
    goal,
    now,
  })
  if (!result.accepted) {
    throw new HTTPError({
      status: 422,
      message: `The goal was refused: ${result.reason}.`,
      body: { code: 'SUBMISSION_REFUSED', reason: result.reason },
      data: { submission: result.submission },
    })
  }
  event.res.status = 201
  return result.submission
})
