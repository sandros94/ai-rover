import { defineMissionHandler } from '../../utils/mission/http'

/** Brings the mission up to date and reports what changed; for schedulers as much as clients. */
export default defineMissionHandler(
  { access: 'write', cache: 'none' },
  async (_event, { tick }) => tick,
)
