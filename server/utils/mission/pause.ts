import type { DB } from '../../database/db'
import { getActivePause } from '../../repositories/pauses'
import { LifecycleError } from './errors'

/** Throws `MISSION_PAUSED` with the operator's message while the mission is paused. */
export async function assertNotPaused(db: DB, missionId: string): Promise<void> {
  const pause = await getActivePause(db, missionId)
  if (pause) throw new LifecycleError('MISSION_PAUSED', pause.message)
}
