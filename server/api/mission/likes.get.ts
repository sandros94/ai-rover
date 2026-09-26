import { listLikedSubmissionIds } from '../../repositories/likes'
import { getOpenRound } from '../../repositories/rounds'
import { useDB } from '../../utils/db'
import { defineMissionHandler } from '../../utils/mission/http'

/**
 * The open round's submissions the signed-in user likes. Kept apart from the public mission
 * state, which is the same for everyone.
 */
export default defineMissionHandler(
  { access: 'read', cache: 'none', user: true },
  async (event, { missionId, user }) => {
    const round = await getOpenRound(useDB(), missionId)
    return {
      roundId: round?.id ?? null,
      submissionIds: round
        ? await listLikedSubmissionIds(useDB(), { roundId: round.id, userId: user.id })
        : [],
    }
  },
)
