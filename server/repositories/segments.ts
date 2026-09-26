import { and, asc, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import type { DriveOutcome } from '#shared/utils/drive/segment'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import type { Segment } from '../database/schema'
import { segment, stop } from '../database/schema'

export interface NewSegment {
  /** Made in code when the id must be known before the row exists (it names the journey blobs). */
  id?: string
  missionId: string
  roundId: string
  submissionId: string
  fromStopId: string
  startedAt: Date
  /** Release time of the last slice. */
  endsAt: Date
  manifestKey: string
  /** Null only while a producer outside the request is still computing it. */
  outcome: DriveOutcome | null
}

type SegmentBase = Omit<Segment, 'outcome' | 'endsAt'>

/**
 * A segment as the public may see it at some instant: the end time and the outcome only once the
 * last slice is released, since either would reveal how the drive ends.
 */
export type PublicSegment =
  | (SegmentBase & { released: false })
  | (SegmentBase & { released: true; endsAt: Date; outcome: DriveOutcome | null })

export interface Death {
  segmentId: string
  fromStopId: string
  x: number
  y: number
  /** When the failure became public: the segment's end. */
  at: Date
}

/** Starts `driving`; `attempt` counts the settled failures before it from the same stop. */
export async function createSegment(db: DB, input: NewSegment): Promise<Segment> {
  return db.transaction(async (tx) => {
    const [from] = await tx
      .select({ missionId: stop.missionId })
      .from(stop)
      .where(eq(stop.id, input.fromStopId))
    if (from?.missionId !== input.missionId) {
      throw new DbError(
        'INVALID_STATE',
        `Stop ${input.fromStopId} is not a stop of mission ${input.missionId}; start the segment from one of its stops.`,
      )
    }
    const [failures] = await tx
      .select({ n: count() })
      .from(segment)
      .where(and(eq(segment.fromStopId, input.fromStopId), eq(segment.status, 'failed')))
    const [row] = await tx
      .insert(segment)
      .values({ ...input, status: 'driving', attempt: 1 + failures!.n })
      .returning()
    return row!
  })
}

export async function getSegment(db: DB, segmentId: string): Promise<Segment> {
  const [row] = await db.select().from(segment).where(eq(segment.id, segmentId))
  if (!row) throw new DbError('NOT_FOUND', `Segment ${segmentId} does not exist.`)
  return row
}

/** The mission's unsettled segment, at most one; its outcome is private, so keep this server-side. */
export async function getDrivingSegment(db: DB, missionId: string): Promise<Segment | undefined> {
  const [row] = await db
    .select()
    .from(segment)
    .where(and(eq(segment.missionId, missionId), eq(segment.status, 'driving')))
    .orderBy(desc(segment.startedAt), desc(segment.id))
    .limit(1)
  return row
}

/** The mission's most recently started segment, settled or not. */
export async function getLatestSegment(db: DB, missionId: string): Promise<Segment | undefined> {
  const [row] = await db
    .select()
    .from(segment)
    .where(eq(segment.missionId, missionId))
    .orderBy(desc(segment.startedAt), desc(segment.id))
    .limit(1)
  return row
}

export type SegmentSettlement =
  | { status: 'failed'; death: { x: number; y: number } }
  | { status: 'arrived' | 'stopped-short'; toStopId: string }

/**
 * Makes a released segment's ending public on its row: where the rover died, or the stop it
 * reached. Refused before `endsAt` and once settled.
 */
export async function settleSegment(
  db: DB,
  segmentId: string,
  settlement: SegmentSettlement & { now: Date },
): Promise<Segment> {
  const fields =
    settlement.status === 'failed'
      ? { status: settlement.status, deathX: settlement.death.x, deathY: settlement.death.y }
      : { status: settlement.status, toStopId: settlement.toStopId }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(segment).where(eq(segment.id, segmentId)).for('update')
    if (!current) throw new DbError('NOT_FOUND', `Segment ${segmentId} does not exist.`)
    if (current.status !== 'driving') {
      throw new DbError('INVALID_STATE', `Segment ${segmentId} is already ${current.status}.`)
    }
    if (current.endsAt.getTime() > settlement.now.getTime()) {
      throw new DbError(
        'INVALID_STATE',
        `Segment ${segmentId} is released at ${current.endsAt.toISOString()}; settle it after that.`,
      )
    }
    const [row] = await tx.update(segment).set(fields).where(eq(segment.id, segmentId)).returning()
    return row!
  })
}

export async function getPublicSegment(
  db: DB,
  segmentId: string,
  options: { now: Date },
): Promise<PublicSegment> {
  const [row] = await db.select().from(segment).where(eq(segment.id, segmentId))
  if (!row) throw new DbError('NOT_FOUND', `Segment ${segmentId} does not exist.`)
  return publicSegment(row, options.now)
}

/** The mission's segments in start order, as public at `now`. */
export async function listMissionSegments(
  db: DB,
  missionId: string,
  options: { now: Date },
): Promise<PublicSegment[]> {
  const rows = await db
    .select()
    .from(segment)
    .where(eq(segment.missionId, missionId))
    .orderBy(asc(segment.startedAt), asc(segment.id))
  return rows.map((row) => publicSegment(row, options.now))
}

export function publicSegment(row: Segment, now: Date): PublicSegment {
  const { outcome, endsAt, ...base } = row
  if (endsAt.getTime() <= now.getTime()) return { ...base, released: true, endsAt, outcome }
  return { ...base, released: false }
}

/** A segment whose ending is public, as the journey totals need it. */
export interface SettledSegment {
  id: string
  status: 'arrived' | 'stopped-short' | 'failed'
  startedAt: Date
  fromStopId: string
  /** Ground distance the drive covered, metres. */
  distanceM: number
  /** Where the rover was lost; null unless failed. */
  death: { x: number; y: number } | null
}

/** The mission's settled segments in start order; the one driving is left out. */
export async function listSettledSegments(db: DB, missionId: string): Promise<SettledSegment[]> {
  const rows = await db
    .select({
      id: segment.id,
      status: segment.status,
      startedAt: segment.startedAt,
      fromStopId: segment.fromStopId,
      outcome: segment.outcome,
      deathX: segment.deathX,
      deathY: segment.deathY,
    })
    .from(segment)
    .where(and(eq(segment.missionId, missionId), ne(segment.status, 'driving')))
    .orderBy(asc(segment.startedAt), asc(segment.id))
  return rows.map((row) => ({
    id: row.id,
    status: row.status as SettledSegment['status'],
    startedAt: row.startedAt,
    fromStopId: row.fromStopId,
    // A segment settles only once its outcome is written.
    distanceM: row.outcome!.distanceM,
    // The settled check constraint makes both coordinates non-null on a failed segment.
    death: row.status === 'failed' ? { x: row.deathX!, y: row.deathY! } : null,
  }))
}

/** Death positions of settled failures, oldest first; unsettled ones are not public yet. */
export async function listDeaths(
  db: DB,
  missionId: string,
  options: { fromStopId?: string } = {},
): Promise<Death[]> {
  const rows = await db
    .select({
      segmentId: segment.id,
      fromStopId: segment.fromStopId,
      x: segment.deathX,
      y: segment.deathY,
      at: segment.endsAt,
    })
    .from(segment)
    .where(
      and(
        eq(segment.missionId, missionId),
        eq(segment.status, 'failed'),
        options.fromStopId ? eq(segment.fromStopId, options.fromStopId) : undefined,
      ),
    )
    .orderBy(asc(segment.endsAt), asc(segment.id))
  // The settled check constraint makes both coordinates non-null on a failed segment.
  return rows.map((row) => ({ ...row, x: row.x!, y: row.y! }))
}

/**
 * Settled failures of the mission whose death lies within `radiusM` (inclusive) of `point`;
 * `since` keeps only those that became public at or after it.
 */
export async function countRecentFailuresNear(
  db: DB,
  missionId: string,
  options: { point: { x: number; y: number }; radiusM: number; since?: Date },
): Promise<number> {
  const { point, radiusM, since } = options
  const [row] = await db
    .select({ n: count() })
    .from(segment)
    .where(
      and(
        eq(segment.missionId, missionId),
        eq(segment.status, 'failed'),
        sql`(${segment.deathX} - ${point.x}::float8) ^ 2 + (${segment.deathY} - ${point.y}::float8) ^ 2 <= ${radiusM}::float8 ^ 2`,
        since ? gte(segment.endsAt, since) : undefined,
      ),
    )
  return row?.n ?? 0
}
