import { eq } from 'drizzle-orm'
import type { Db } from '../database/db'
import { DbError } from '../database/errors'
import type { Mission, MissionConfig } from '../database/schema'
import { mission, stop } from '../database/schema'

export async function createMission(
  db: Db,
  input: { seed: string; worldHash: string; config: MissionConfig; solsEpoch?: Date },
): Promise<Mission> {
  const [row] = await db.insert(mission).values(input).returning()
  return row!
}

export async function getMission(db: Db, missionId: string): Promise<Mission> {
  const [row] = await db.select().from(mission).where(eq(mission.id, missionId))
  if (!row) throw new DbError('NOT_FOUND', `Mission ${missionId} does not exist.`)
  return row
}

export async function setCurrentStop(db: Db, missionId: string, stopId: string): Promise<Mission> {
  return db.transaction(async (tx) => {
    await getMission(tx, missionId)
    const [target] = await tx
      .select({ missionId: stop.missionId })
      .from(stop)
      .where(eq(stop.id, stopId))
    if (target?.missionId !== missionId) {
      throw new DbError(
        'INVALID_STATE',
        `Stop ${stopId} is not a stop of mission ${missionId}; pass one from listStops(${missionId}).`,
      )
    }
    const [row] = await tx
      .update(mission)
      .set({ currentStopId: stopId })
      .where(eq(mission.id, missionId))
      .returning()
    return row!
  })
}
