import { defineRelations, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { uuidv7 } from 'unsecure/uuid'
import type { DriveOutcome } from '#shared/utils/drive/segment'
import type { ExplorationParts } from '#shared/utils/mission/exploration'
import type { MissionRules } from '#shared/utils/mission/rules'
import type { NavMetrics } from '#shared/utils/nav/plan'
import type { SubmissionSummary } from '#shared/utils/nav/summary'
import type { WorldConfig } from '#shared/utils/terrain/world'
import type { JudgedAnswers, SubmissionJudgment } from '../utils/jev/client'

// Ids are UUIDv7 made in code, so rows sort by creation without a database default.
const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7())
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()

/** Quoted SQL list for a CHECK over a closed set of text values. */
function oneOf(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '))
}

export const IDENTITY_PROVIDERS = ['github', 'discord', 'atproto'] as const
export const MISSION_STATUSES = ['active', 'ended'] as const
/** `void`: the drive beside the round failed, so nothing won it and it never starts a segment. */
export const ROUND_STATUSES = ['open', 'closed', 'void'] as const
export const SUBMISSION_STATUSES = ['open', 'rejected', 'won', 'lost', 'withdrawn'] as const
/**
 * Why a submission is `rejected`. `judged-infeasible`: Jev's verdict was reject when it was
 * submitted. `invalidated-by-stop`: the drive it waited beside stopped short, and from the stop
 * reached it broke a rule or was judged infeasible.
 */
export const REJECTION_REASONS = ['judged-infeasible', 'invalidated-by-stop'] as const
export const SEGMENT_STATUSES = ['driving', 'arrived', 'stopped-short', 'failed'] as const

/** Stored with the mission: world overrides (the seed is its own column) and the rules. */
export interface MissionConfig {
  world: Omit<WorldConfig, 'seed'>
  rules: MissionRules
}

/**
 * A judgment as stored; whether it came from the cache is irrelevant once stored. Judgments stored
 * before Jev was asked about exploration lack its answer; the submission's `exploration` column
 * holds the value that ranks either way.
 */
export type StoredJudgment = Omit<
  SubmissionJudgment,
  'cached' | 'explorationValue' | 'explorationWeight'
> &
  Partial<Pick<SubmissionJudgment, 'explorationValue' | 'explorationWeight'>>

/**
 * The name, avatar and handle are those of the identity `primary_provider` names, copied from it
 * whenever it changes; an account without identities (a development login) keeps its own.
 */
export const userAccount = snakeCase.table(
  'user_account',
  {
    id: id(),
    createdAt: createdAt(),
    displayName: text().notNull(),
    avatarUrl: text(),
    handle: text(),
    /** One of the account's own identities; the repository keeps it so. */
    primaryProvider: text({ enum: IDENTITY_PROVIDERS }),
    /**
     * The development login that signs in as this account, which linking and switching the
     * primary identity leave alone; null for every account outside local development.
     */
    devLogin: text().unique(),
  },
  (t) => [
    check(
      'user_account_primary_provider_check',
      sql`${t.primaryProvider} is null or ${t.primaryProvider} in (${oneOf(IDENTITY_PROVIDERS)})`,
    ),
  ],
)

export const userIdentity = snakeCase.table(
  'user_identity',
  {
    provider: text({ enum: IDENTITY_PROVIDERS }).notNull(),
    /** The provider's stable account id (a DID for AT Protocol, the numeric id for GitHub and Discord). */
    subject: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => userAccount.id),
    /** The provider's profile as of the last sign-in with this identity. */
    displayName: text().notNull(),
    avatarUrl: text(),
    handle: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    // One identity per provider and user, so a provider names the identity within an account.
    unique('user_identity_user_provider_unique').on(t.userId, t.provider),
    check('user_identity_provider_check', sql`${t.provider} in (${oneOf(IDENTITY_PROVIDERS)})`),
  ],
)

export const mission = snakeCase.table(
  'mission',
  {
    id: id(),
    createdAt: createdAt(),
    seed: text().notNull(),
    worldHash: text().notNull(),
    config: jsonb().$type<MissionConfig>().notNull(),
    status: text({ enum: MISSION_STATUSES }).notNull().default('active'),
    currentStopId: uuid().references((): AnyPgColumn => stop.id),
    /** Mission start, the zero of the sol clock. */
    solsEpoch: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * When a tick next has something to do (a drive to settle, a round to close); null while
     * nothing is pending. Kept by every tick and submission so a read can skip the tick's lock.
     * An early value only costs a tick that finds nothing to do.
     */
    nextDueAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check('mission_status_check', sql`${t.status} in (${oneOf(MISSION_STATUSES)})`),
    check('mission_world_hash_check', sql`${t.worldHash} ~ '^[0-9a-f]{16}$'`),
  ],
)

export const stop = snakeCase.table(
  'stop',
  {
    id: id(),
    missionId: uuid()
      .notNull()
      .references(() => mission.id),
    index: integer().notNull(),
    x: doublePrecision().notNull(),
    y: doublePrecision().notNull(),
    headingRad: doublePrecision().notNull(),
    manifestKey: text().notNull(),
    revealedKey: text().notNull(),
    /** The segment that reached this stop; null for the landing stop. */
    fromSegmentId: uuid().references((): AnyPgColumn => segment.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('stop_mission_index_unique').on(t.missionId, t.index),
    check('stop_index_check', sql`${t.index} >= 0`),
  ],
)

export const round = snakeCase.table(
  'round',
  {
    id: id(),
    missionId: uuid()
      .notNull()
      .references(() => mission.id),
    /**
     * The stop the rover is at, or leaves from while the drive beside the round plays; the segment
     * the round decides starts where the rover is once that drive settles. Several rounds share
     * a stop after a failure.
     */
    fromStopId: uuid()
      .notNull()
      .references(() => stop.id),
    /**
     * Where submissions are measured and planned from: the stop's position, or during a drive
     * its planned destination (the winner's goal, already public), so nothing about where the
     * drive really ends is used before it settles.
     */
    anchorX: doublePrecision().notNull(),
    anchorY: doublePrecision().notNull(),
    opensAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closesAt: timestamp({ withTimezone: true }),
    status: text({ enum: ROUND_STATUSES }).notNull().default('open'),
    winnerSubmissionId: uuid().references((): AnyPgColumn => submission.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('round_open_per_mission_idx')
      .on(t.missionId)
      .where(sql`${t.status} = 'open'`),
    index('round_mission_idx').on(t.missionId),
    check('round_status_check', sql`${t.status} in (${oneOf(ROUND_STATUSES)})`),
    check(
      'round_winner_check',
      sql`(${t.status} in ('open', 'void') and ${t.winnerSubmissionId} is null) or (${t.status} = 'closed' and ${t.winnerSubmissionId} is not null)`,
    ),
  ],
)

export const submission = snakeCase.table(
  'submission',
  {
    id: id(),
    roundId: uuid()
      .notNull()
      .references(() => round.id),
    userId: uuid()
      .notNull()
      .references(() => userAccount.id),
    goalX: doublePrecision().notNull(),
    goalY: doublePrecision().notNull(),
    status: text({ enum: SUBMISSION_STATUSES }).notNull().default('open'),
    /** Set exactly when `status` is `rejected`. */
    rejectionReason: text({ enum: REJECTION_REASONS }),
    judgment: jsonb().$type<StoredJudgment>().notNull(),
    metrics: jsonb().$type<NavMetrics>().notNull(),
    summary: jsonb().$type<SubmissionSummary>().notNull(),
    /** How much new ground the goal opens, 0 to 1: the mean of the code's value and Jev's. */
    exploration: doublePrecision().notNull(),
    /** The code's parts of the exploration value, from public data at planning time. */
    explorationParts: jsonb().$type<ExplorationParts>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('submission_open_per_user_idx')
      .on(t.roundId, t.userId)
      .where(sql`${t.status} = 'open'`),
    index('submission_round_idx').on(t.roundId),
    check('submission_status_check', sql`${t.status} in (${oneOf(SUBMISSION_STATUSES)})`),
    // A check passes on unknown, and `in` over a null is unknown: hence the explicit `is not null`.
    check(
      'submission_rejection_check',
      sql`(${t.status} = 'rejected' and ${t.rejectionReason} is not null and ${t.rejectionReason} in (${oneOf(REJECTION_REASONS)})) or (${t.status} <> 'rejected' and ${t.rejectionReason} is null)`,
    ),
  ],
)

export const submissionLike = snakeCase.table(
  'submission_like',
  {
    submissionId: uuid()
      .notNull()
      .references(() => submission.id),
    userId: uuid()
      .notNull()
      .references(() => userAccount.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.userId] })],
)

export const segment = snakeCase.table(
  'segment',
  {
    id: id(),
    missionId: uuid()
      .notNull()
      .references(() => mission.id),
    roundId: uuid()
      .notNull()
      .references(() => round.id),
    submissionId: uuid()
      .notNull()
      .references(() => submission.id),
    fromStopId: uuid()
      .notNull()
      .references(() => stop.id),
    /** Set on settling an arrival or a stop short; a failure leaves the rover's stop unchanged. */
    toStopId: uuid().references(() => stop.id),
    status: text({ enum: SEGMENT_STATUSES }).notNull().default('driving'),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** Release time of the last slice: the outcome and this time stay private until then. */
    endsAt: timestamp({ withTimezone: true }).notNull(),
    manifestKey: text().notNull(),
    /** Known from the start; null only while a producer outside the request is still running. */
    outcome: jsonb().$type<DriveOutcome>(),
    deathX: doublePrecision(),
    deathY: doublePrecision(),
    /** 1 + the failed segments before it from the same stop. */
    attempt: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('segment_round_unique').on(t.roundId),
    unique('segment_submission_unique').on(t.submissionId),
    index('segment_mission_from_stop_idx').on(t.missionId, t.fromStopId),
    check('segment_status_check', sql`${t.status} in (${oneOf(SEGMENT_STATUSES)})`),
    check('segment_attempt_check', sql`${t.attempt} >= 1`),
    check('segment_window_check', sql`${t.endsAt} >= ${t.startedAt}`),
    check(
      'segment_settled_check',
      sql`case ${t.status}
        when 'driving' then ${t.toStopId} is null and ${t.deathX} is null and ${t.deathY} is null
        when 'failed' then ${t.toStopId} is null and ${t.deathX} is not null and ${t.deathY} is not null
        else ${t.toStopId} is not null and ${t.deathX} is null and ${t.deathY} is null
      end`,
    ),
  ],
)

/**
 * A signed-in viewer's "rover not moving" flag on a playing drive, one per user and segment;
 * flagging again moves `created_at` to now, so only flags within the rules' window count.
 */
export const segmentFlag = snakeCase.table(
  'segment_flag',
  {
    segmentId: uuid()
      .notNull()
      .references(() => segment.id),
    userId: uuid()
      .notNull()
      .references(() => userAccount.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.userId] })],
)

/**
 * An operator's pause of a mission, with the message shown while it lasts; at most one active
 * (not resumed) per mission. Set through the database.
 */
export const missionPause = snakeCase.table(
  'mission_pause',
  {
    id: id(),
    missionId: uuid()
      .notNull()
      .references(() => mission.id),
    message: text().notNull(),
    pausedBy: uuid()
      .notNull()
      .references(() => userAccount.id),
    pausedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resumedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mission_pause_active_idx')
      .on(t.missionId)
      .where(sql`${t.resumedAt} is null`),
    check(
      'mission_pause_window_check',
      sql`${t.resumedAt} is null or ${t.resumedAt} >= ${t.pausedAt}`,
    ),
  ],
)

/**
 * Jev's answers by request hash (SHA-256 of model, state and questions), so an identical
 * submission is never paid for twice. Rows never change once written.
 */
export const aiJudgment = snakeCase.table('ai_judgment', {
  hash: text().primaryKey(),
  model: text().notNull(),
  answers: jsonb().$type<JudgedAnswers>().notNull(),
  createdAt: createdAt(),
})

export const schema = {
  userAccount,
  userIdentity,
  mission,
  stop,
  round,
  submission,
  submissionLike,
  segment,
  segmentFlag,
  missionPause,
  aiJudgment,
}

export const relations = defineRelations(schema, (r) => ({
  userAccount: {
    identities: r.many.userIdentity(),
    submissions: r.many.submission(),
  },
  userIdentity: {
    user: r.one.userAccount({ from: r.userIdentity.userId, to: r.userAccount.id, optional: false }),
  },
  mission: {
    stops: r.many.stop({ alias: 'mission_stops' }),
    rounds: r.many.round(),
    segments: r.many.segment(),
    currentStop: r.one.stop({
      from: r.mission.currentStopId,
      to: r.stop.id,
      alias: 'current_stop',
    }),
  },
  stop: {
    mission: r.one.mission({
      from: r.stop.missionId,
      to: r.mission.id,
      optional: false,
      alias: 'mission_stops',
    }),
    fromSegment: r.one.segment({ from: r.stop.fromSegmentId, to: r.segment.id, alias: 'reached' }),
  },
  round: {
    mission: r.one.mission({ from: r.round.missionId, to: r.mission.id, optional: false }),
    fromStop: r.one.stop({ from: r.round.fromStopId, to: r.stop.id, optional: false }),
    submissions: r.many.submission({ alias: 'round_submissions' }),
    winner: r.one.submission({
      from: r.round.winnerSubmissionId,
      to: r.submission.id,
      alias: 'winner',
    }),
    segment: r.one.segment({ from: r.round.id, to: r.segment.roundId }),
  },
  submission: {
    round: r.one.round({
      from: r.submission.roundId,
      to: r.round.id,
      optional: false,
      alias: 'round_submissions',
    }),
    user: r.one.userAccount({ from: r.submission.userId, to: r.userAccount.id, optional: false }),
    likes: r.many.submissionLike(),
  },
  submissionLike: {
    submission: r.one.submission({
      from: r.submissionLike.submissionId,
      to: r.submission.id,
      optional: false,
    }),
    user: r.one.userAccount({
      from: r.submissionLike.userId,
      to: r.userAccount.id,
      optional: false,
    }),
  },
  segment: {
    mission: r.one.mission({ from: r.segment.missionId, to: r.mission.id, optional: false }),
    round: r.one.round({ from: r.segment.roundId, to: r.round.id, optional: false }),
    submission: r.one.submission({
      from: r.segment.submissionId,
      to: r.submission.id,
      optional: false,
    }),
    fromStop: r.one.stop({
      from: r.segment.fromStopId,
      to: r.stop.id,
      optional: false,
      alias: 'departures',
    }),
    toStop: r.one.stop({ from: r.segment.toStopId, to: r.stop.id, alias: 'arrivals' }),
  },
}))

export type UserAccount = typeof userAccount.$inferSelect
export type NewUserAccount = typeof userAccount.$inferInsert
export type UserIdentity = typeof userIdentity.$inferSelect
export type NewUserIdentity = typeof userIdentity.$inferInsert
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number]
export type Mission = typeof mission.$inferSelect
export type NewMission = typeof mission.$inferInsert
export type Stop = typeof stop.$inferSelect
export type NewStop = typeof stop.$inferInsert
export type Round = typeof round.$inferSelect
export type NewRound = typeof round.$inferInsert
export type Submission = typeof submission.$inferSelect
export type NewSubmissionRow = typeof submission.$inferInsert
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]
export type RejectionReason = (typeof REJECTION_REASONS)[number]
export type SubmissionLike = typeof submissionLike.$inferSelect
export type Segment = typeof segment.$inferSelect
export type NewSegment = typeof segment.$inferInsert
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number]
export type AiJudgment = typeof aiJudgment.$inferSelect
export type SegmentFlag = typeof segmentFlag.$inferSelect
export type MissionPause = typeof missionPause.$inferSelect
