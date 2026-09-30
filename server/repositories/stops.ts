import { asc, eq, max } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import type { Stop } from '../database/schema'
import { stop } from '../database/schema'

export interface NewStop {
  missionId: string
  /** 0 for the landing stop, then one more per stop reached; unique within the mission. */
  index: number
  x: number
  y: number
  headingRad: number
  manifestKey: string
  revealedKey: string
  fromSegmentId?: string | null
}

export async function createStop(db: DB, input: NewStop): Promise<Stop> {
  const [row] = await db.insert(stop).values(input).returning()
  return row!
}

export async function listStops(db: DB, missionId: string): Promise<Stop[]> {
  return db.select().from(stop).where(eq(stop.missionId, missionId)).orderBy(asc(stop.index))
}

/** One more than the highest stop index of the mission; 0 before its landing stop. */
export async function nextStopIndex(db: DB, missionId: string): Promise<number> {
  const [row] = await db
    .select({ index: max(stop.index) })
    .from(stop)
    .where(eq(stop.missionId, missionId))
  return row?.index === null || row?.index === undefined ? 0 : row.index + 1
}

export async function getStop(db: DB, stopId: string): Promise<Stop> {
  const [row] = await db.select().from(stop).where(eq(stop.id, stopId))
  if (!row) throw new DbError('NOT_FOUND', `Stop ${stopId} does not exist.`)
  return row
}

/** Points the stop at other stored objects: its manifest and the revealed mask it names. */
export async function setStopObjects(
  db: DB,
  stopId: string,
  keys: { manifestKey: string; revealedKey: string },
): Promise<Stop> {
  const [row] = await db
    .update(stop)
    .set({ manifestKey: keys.manifestKey, revealedKey: keys.revealedKey })
    .where(eq(stop.id, stopId))
    .returning()
  if (!row) throw new DbError('NOT_FOUND', `Stop ${stopId} does not exist.`)
  return row
}
