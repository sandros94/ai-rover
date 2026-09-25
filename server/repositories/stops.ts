import { asc, eq } from 'drizzle-orm'
import type { Db } from '../database/db'
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

export async function createStop(db: Db, input: NewStop): Promise<Stop> {
  const [row] = await db.insert(stop).values(input).returning()
  return row!
}

export async function listStops(db: Db, missionId: string): Promise<Stop[]> {
  return db.select().from(stop).where(eq(stop.missionId, missionId)).orderBy(asc(stop.index))
}

export async function getStop(db: Db, stopId: string): Promise<Stop> {
  const [row] = await db.select().from(stop).where(eq(stop.id, stopId))
  if (!row) throw new DbError('NOT_FOUND', `Stop ${stopId} does not exist.`)
  return row
}
