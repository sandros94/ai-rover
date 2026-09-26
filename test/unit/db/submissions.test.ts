import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { eq } from 'drizzle-orm'
import { submission as submissionTable } from '#server/database/schema'
import { closeRound, reanchorRound } from '#server/repositories/rounds'
import { createStop } from '#server/repositories/stops'
import {
  createSubmission,
  listRoundSubmissions,
  rejectSubmission,
  reviseSubmission,
  setSubmissionStatus,
  withdrawSubmission,
} from '#server/repositories/submissions'
import { countLikes, like, listLikedSubmissionIds, unlike } from '#server/repositories/likes'
import { createUser } from '#server/repositories/users'
import {
  createTestDb,
  dbErrorOf,
  JUDGMENT,
  METRICS,
  seedMission,
  SUMMARY,
  submissionInput,
} from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('submissions', () => {
  it('stores the goal, judgment, metrics and summary', async () => {
    const { round, user } = await seedMission(db)
    const submission = await createSubmission(db, submissionInput(round, user.id))
    expect(submission).toMatchObject({
      roundId: round.id,
      userId: user.id,
      goalX: 0,
      goalY: 80,
      status: 'open',
      judgment: JUDGMENT,
      metrics: METRICS,
      summary: SUMMARY,
    })
    expect(submission.updatedAt).toBeInstanceOf(Date)
  })

  it('refuses a second open submission by the same user in the round', async () => {
    const { round, user } = await seedMission(db)
    await createSubmission(db, submissionInput(round, user.id))
    const error = await dbErrorOf(createSubmission(db, submissionInput(round, user.id)))
    expect(error?.code).toBe('ALREADY_SUBMITTED')
    expect(error?.message).toMatch(/withdraw/i)
  })

  it('allows a new submission after withdrawal', async () => {
    const { round, user } = await seedMission(db)
    const first = await createSubmission(db, submissionInput(round, user.id))
    const withdrawn = await withdrawSubmission(db, first.id, { userId: user.id })
    expect(withdrawn.status).toBe('withdrawn')
    expect(withdrawn.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime())
    const second = await createSubmission(db, submissionInput(round, user.id, { x: 50, y: 50 }))
    expect(second.status).toBe('open')
  })

  it("refuses to withdraw another user's or a settled submission", async () => {
    const { round, user } = await seedMission(db)
    const other = await createUser(db, { displayName: 'Other' })
    const submission = await createSubmission(db, submissionInput(round, user.id))
    expect(
      (await dbErrorOf(withdrawSubmission(db, submission.id, { userId: other.id })))?.code,
    ).toBe('INVALID_STATE')
    await rejectSubmission(db, submission.id, { reason: 'judged-infeasible' })
    expect(
      (await dbErrorOf(withdrawSubmission(db, submission.id, { userId: user.id })))?.code,
    ).toBe('INVALID_STATE')
    expect((await dbErrorOf(setSubmissionStatus(db, submission.id, 'won')))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it('revises and rejects only open submissions, a rejection always carrying its reason', async () => {
    const { round, user } = await seedMission(db)
    const submission = await createSubmission(db, submissionInput(round, user.id))
    expect(submission.rejectionReason).toBeNull()
    const metrics = { ...METRICS, straightLineM: 90 }
    const revised = await reviseSubmission(db, submission.id, {
      judgment: { ...JUDGMENT, feasible: 0.5 },
      metrics,
      summary: SUMMARY,
    })
    expect(revised).toMatchObject({ status: 'open', metrics, judgment: { feasible: 0.5 } })
    const rejected = await rejectSubmission(db, submission.id, { reason: 'invalidated-by-stop' })
    expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'invalidated-by-stop' })
    expect(
      (
        await dbErrorOf(
          reviseSubmission(db, submission.id, { judgment: JUDGMENT, metrics, summary: SUMMARY }),
        )
      )?.code,
    ).toBe('INVALID_STATE')
    expect(
      (await dbErrorOf(rejectSubmission(db, submission.id, { reason: 'judged-infeasible' })))?.code,
    ).toBe('INVALID_STATE')
    // The schema refuses a rejection without a reason and a reason on anything else.
    const REJECTION_CHECK = { cause: { code: '23514', constraint: 'submission_rejection_check' } }
    const stored = await createSubmission(db, {
      ...submissionInput(round, user.id, { x: 60, y: 0 }),
      status: 'rejected',
      rejectionReason: 'judged-infeasible',
    })
    expect(stored.rejectionReason).toBe('judged-infeasible')
    await expect(
      db
        .update(submissionTable)
        .set({ rejectionReason: null })
        .where(eq(submissionTable.id, stored.id)),
    ).rejects.toMatchObject(REJECTION_CHECK)
    await expect(
      db.update(submissionTable).set({ status: 'lost' }).where(eq(submissionTable.id, stored.id)),
    ).rejects.toMatchObject(REJECTION_CHECK)
  })

  it('refuses a submission to a closed round', async () => {
    const { round, user } = await seedMission(db)
    const winner = await createSubmission(db, submissionInput(round, user.id))
    await closeRound(db, round.id, { winnerSubmissionId: winner.id, closesAt: new Date() })
    const late = await createUser(db, { displayName: 'Late' })
    expect((await dbErrorOf(createSubmission(db, submissionInput(round, late.id))))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it('refuses a submission planned from a stop or anchor the round has since left', async () => {
    const { mission, round, user } = await seedMission(db)
    const stop1 = await createStop(db, {
      missionId: mission.id,
      index: 1,
      x: 0,
      y: 40,
      headingRad: 0,
      manifestKey: 'missions/m/stops/1.json',
      revealedKey: 'missions/m/revealed/1.bin',
    })
    // Planned while the round still stood at the landing stop.
    const stale = submissionInput(round, user.id)
    await reanchorRound(db, round.id, { fromStopId: stop1.id, anchor: { x: 0, y: 40 } })
    expect((await dbErrorOf(createSubmission(db, stale)))?.code).toBe('ROUND_CHANGED')
    // The anchor alone moving counts too.
    const moved = await reanchorRound(db, round.id, {
      fromStopId: stop1.id,
      anchor: { x: 1, y: 40 },
    })
    const anchorOnly = { ...stale, plannedFrom: { fromStopId: stop1.id, anchor: { x: 0, y: 40 } } }
    expect((await dbErrorOf(createSubmission(db, anchorOnly)))?.code).toBe('ROUND_CHANGED')
    expect(await listRoundSubmissions(db, round.id)).toEqual([])
    expect((await createSubmission(db, submissionInput(moved, user.id))).roundId).toBe(round.id)
  })

  it('lists submissions with like counts and the submitter', async () => {
    const { round, user } = await seedMission(db)
    const grace = await createUser(db, {
      displayName: 'Grace',
      avatarUrl: 'https://example.com/g.png',
    })
    const a = await createSubmission(db, submissionInput(round, user.id))
    const b = await createSubmission(db, submissionInput(round, grace.id, { x: 60, y: 0 }))
    await like(db, a.id, { userId: user.id })
    await like(db, a.id, { userId: grace.id })
    await like(db, b.id, { userId: grace.id })
    const listed = await listRoundSubmissions(db, round.id)
    const byId = Object.fromEntries(listed.map((s) => [s.id, s]))
    expect(byId[a.id]).toMatchObject({
      likes: 2,
      submitter: { id: user.id, displayName: 'Ada', avatarUrl: null },
    })
    expect(byId[b.id]).toMatchObject({
      likes: 1,
      goalX: 60,
      submitter: { id: grace.id, displayName: 'Grace', avatarUrl: 'https://example.com/g.png' },
    })
    expect(listed.map((s) => s.id)).toEqual([a.id, b.id])
  })
})

describe('likes', () => {
  it('likes idempotently, self-like allowed, and unlikes', async () => {
    const { round, user } = await seedMission(db)
    const submission = await createSubmission(db, submissionInput(round, user.id))
    expect(await countLikes(db, submission.id)).toBe(0)
    await like(db, submission.id, { userId: user.id })
    await like(db, submission.id, { userId: user.id })
    expect(await countLikes(db, submission.id)).toBe(1)
    await unlike(db, submission.id, { userId: user.id })
    await unlike(db, submission.id, { userId: user.id })
    expect(await countLikes(db, submission.id)).toBe(0)
  })

  it('refuses likes on a submission that is no longer open', async () => {
    const { round, user } = await seedMission(db)
    const submission = await createSubmission(db, submissionInput(round, user.id))
    await like(db, submission.id, { userId: user.id })
    await withdrawSubmission(db, submission.id, { userId: user.id })
    expect((await dbErrorOf(like(db, submission.id, { userId: user.id })))?.code).toBe(
      'INVALID_STATE',
    )
    expect((await dbErrorOf(unlike(db, submission.id, { userId: user.id })))?.code).toBe(
      'INVALID_STATE',
    )
    expect(
      (await dbErrorOf(like(db, '01900000-0000-7000-8000-000000000000', { userId: user.id })))
        ?.code,
    ).toBe('NOT_FOUND')
  })

  it("lists the round's submissions a user likes, and only that round's", async () => {
    const { round, user } = await seedMission(db)
    const grace = await createUser(db, { displayName: 'Grace', avatarUrl: null })
    const a = await createSubmission(db, submissionInput(round, user.id))
    const b = await createSubmission(db, submissionInput(round, grace.id, { x: 60, y: 0 }))
    expect(await listLikedSubmissionIds(db, { roundId: round.id, userId: grace.id })).toEqual([])
    await like(db, a.id, { userId: grace.id })
    await like(db, b.id, { userId: grace.id })
    await like(db, b.id, { userId: user.id })
    expect(
      (await listLikedSubmissionIds(db, { roundId: round.id, userId: grace.id })).toSorted(),
    ).toEqual([a.id, b.id].toSorted())
    expect(await listLikedSubmissionIds(db, { roundId: round.id, userId: user.id })).toEqual([b.id])
    const other = await seedMission(db)
    expect(await listLikedSubmissionIds(db, { roundId: other.round.id, userId: grace.id })).toEqual(
      [],
    )
  })
})
