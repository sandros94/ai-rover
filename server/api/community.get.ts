import { listCommunityTallies } from '../repositories/community'
import { useDB } from '../utils/db'
import { defineMissionHandler } from '../utils/mission/http'

/**
 * Per-member tallies of the current mission from its settled drives and likes; the same for
 * everyone and slow to change, so browsers and the CDN keep it a minute.
 */
export default defineMissionHandler(
  { access: 'read', cache: 'public', maxAgeS: 60 },
  async (_event, { missionId }) => ({ members: await listCommunityTallies(useDB(), missionId) }),
)
