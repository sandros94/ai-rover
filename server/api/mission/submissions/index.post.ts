import { HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { useDB } from '../../../utils/db'
import { useJevClient } from '../../../utils/jev'
import { defineMissionHandler } from '../../../utils/mission/http'
import { submitGoal } from '../../../utils/mission/submit'
import { BAD_INPUT } from '../../../utils/mission/validation'

const finite = v.pipe(v.number(), v.finite())
const BodySchema = v.object({ goal: v.object({ x: finite, y: finite }) })

/**
 * Submits a goal; a refused one answers 422 with its reason (and the stored rejection, if any),
 * or 409 when the round moved while the goal was judged, so the client plans again.
 */
export default defineMissionHandler(
  { access: 'write', cache: 'none' },
  async (event, { missionId, store, now }) => {
    const userId = (await requireUserSession(event)).user.id
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
        status: result.reason === 'round-changed' ? 409 : 422,
        message: `The goal was refused: ${result.reason}.`,
        body: { code: 'SUBMISSION_REFUSED', reason: result.reason },
        data: { submission: result.submission },
      })
    }
    event.res.status = 201
    return result.submission
  },
)
