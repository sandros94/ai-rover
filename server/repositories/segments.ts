import { and, asc, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DriveOutcome } from '#shared/utils/drive/segment'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import type { Segment, StoredJudgment } from '../database/schema'
import { segment, stop, submission, userAccount } from '../database/schema'

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

/** A settled drive as the journey log shows it: everything about it is public by now. */
export interface JourneySegment {
  id: string
  /** Position among the mission's settled drives, oldest first, from 1. */
  number: number
  /** Tries from the same stop, this one included. */
  attempt: number
  status: SettledSegment['status']
  startedAt: Date
  /** Release of the last slice, when the ending became public. */
  endedAt: Date
  /** Ground distance covered, metres. */
  distanceM: number
  /** Sim time of the last keyframe, seconds. */
  durationS: number
  /** Why the drive fell short or failed; empty on an arrival. */
  reasons: string[]
  from: { id: string; index: number; x: number; y: number }
  /** The stop reached; null for a failure. */
  to: { id: string; index: number; x: number; y: number } | null
  /** The winning submission's destination. */
  goal: { x: number; y: number }
  death: { x: number; y: number } | null
  submitter: { id: string; displayName: string; avatarUrl: string | null }
  judgment: StoredJudgment
  /** Ground distance of the settled drives before this one, metres. */
  journeyBeforeM: number
}

const settledOf = (missionId: string) =>
  and(eq(segment.missionId, missionId), ne(segment.status, 'driving'))

/**
 * The mission's settled drives with their joins; `number` and `journeyBeforeM` are windows over
 * every settled drive, so they hold whatever page or single drive is read.
 */
function journeyQuery(db: DB, missionId: string) {
  const ordered = db
    .select({
      id: segment.id,
      number: sql<number>`row_number() over (order by ${segment.startedAt}, ${segment.id})`.as(
        'number',
      ),
      beforeM:
        sql<number>`coalesce(sum((${segment.outcome} ->> 'distanceM')::float8) over (order by ${segment.startedAt}, ${segment.id} rows between unbounded preceding and 1 preceding), 0)`.as(
          'before_m',
        ),
    })
    .from(segment)
    .where(settledOf(missionId))
    .as('ordered')
  const from = alias(stop, 'from_stop')
  const to = alias(stop, 'to_stop')
  return db
    .select({
      segment,
      number: ordered.number,
      beforeM: ordered.beforeM,
      from: { id: from.id, index: from.index, x: from.x, y: from.y },
      to: { id: to.id, index: to.index, x: to.x, y: to.y },
      goal: { x: submission.goalX, y: submission.goalY },
      judgment: submission.judgment,
      submitter: {
        id: userAccount.id,
        displayName: userAccount.displayName,
        avatarUrl: userAccount.avatarUrl,
      },
    })
    .from(segment)
    .innerJoin(ordered, eq(ordered.id, segment.id))
    .innerJoin(from, eq(from.id, segment.fromStopId))
    .leftJoin(to, eq(to.id, segment.toStopId))
    .innerJoin(submission, eq(submission.id, segment.submissionId))
    .innerJoin(userAccount, eq(userAccount.id, submission.userId))
    .$dynamic()
}

type JourneyRow = Awaited<ReturnType<ReturnType<typeof journeyQuery>['execute']>>[number]

function journeySegment(row: JourneyRow): JourneySegment {
  const s = row.segment
  // A segment settles only once its outcome is written.
  const outcome = s.outcome!
  return {
    id: s.id,
    number: Number(row.number),
    attempt: s.attempt,
    status: s.status as SettledSegment['status'],
    startedAt: s.startedAt,
    endedAt: s.endsAt,
    distanceM: outcome.distanceM,
    durationS: outcome.durationS,
    reasons: [...outcome.reasons],
    from: row.from,
    to: row.to,
    goal: row.goal,
    // The settled check constraint makes both coordinates non-null on a failed segment.
    death: s.status === 'failed' ? { x: s.deathX!, y: s.deathY! } : null,
    submitter: row.submitter,
    judgment: row.judgment,
    journeyBeforeM: Number(row.beforeM),
  }
}

/** A page of the mission's settled drives, newest first, with how many there are in all. */
export async function listJourneySegments(
  db: DB,
  missionId: string,
  options: { limit: number; offset: number },
): Promise<{ segments: JourneySegment[]; total: number }> {
  const rows = await journeyQuery(db, missionId)
    .orderBy(desc(segment.startedAt), desc(segment.id))
    .limit(options.limit)
    .offset(options.offset)
  const [counted] = await db.select({ n: count() }).from(segment).where(settledOf(missionId))
  return { segments: rows.map(journeySegment), total: counted?.n ?? 0 }
}

/** One settled drive of the mission; NOT_FOUND for one still driving, unknown or elsewhere. */
export async function getJourneySegment(
  db: DB,
  segmentId: string,
  options: { missionId: string },
): Promise<JourneySegment> {
  const [row] = await journeyQuery(db, options.missionId).where(eq(segment.id, segmentId))
  if (!row) {
    throw new DbError(
      'NOT_FOUND',
      `Segment ${segmentId} is not a settled drive of mission ${options.missionId}.`,
    )
  }
  return journeySegment(row)
}
