import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { closeRound } from '#server/repositories/rounds'
import {
  createSubmission,
  listRoundSubmissions,
  setSubmissionStatus,
  withdrawSubmission,
} from '#server/repositories/submissions'
import { countLikes, like, unlike } from '#server/repositories/likes'
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
    const submission = await createSubmission(db, submissionInput(round.id, user.id))
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
    await createSubmission(db, submissionInput(round.id, user.id))
    const error = await dbErrorOf(createSubmission(db, submissionInput(round.id, user.id)))
    expect(error?.code).toBe('ALREADY_SUBMITTED')
    expect(error?.message).toMatch(/withdraw/i)
  })

  it('allows a new submission after withdrawal', async () => {
    const { round, user } = await seedMission(db)
    const first = await createSubmission(db, submissionInput(round.id, user.id))
    const withdrawn = await withdrawSubmission(db, first.id, { userId: user.id })
    expect(withdrawn.status).toBe('withdrawn')
    expect(withdrawn.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime())
    const second = await createSubmission(db, submissionInput(round.id, user.id, { x: 50, y: 50 }))
    expect(second.status).toBe('open')
  })

  it("refuses to withdraw another user's or a settled submission", async () => {
    const { round, user } = await seedMission(db)
    const other = await createUser(db, { displayName: 'Other' })
    const submission = await createSubmission(db, submissionInput(round.id, user.id))
    expect(
      (await dbErrorOf(withdrawSubmission(db, submission.id, { userId: other.id })))?.code,
    ).toBe('INVALID_STATE')
    await setSubmissionStatus(db, submission.id, 'rejected')
    expect(
      (await dbErrorOf(withdrawSubmission(db, submission.id, { userId: user.id })))?.code,
    ).toBe('INVALID_STATE')
    expect((await dbErrorOf(setSubmissionStatus(db, submission.id, 'won')))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it('refuses a submission to a closed round', async () => {
    const { round, user } = await seedMission(db)
    const winner = await createSubmission(db, submissionInput(round.id, user.id))
    await closeRound(db, round.id, { winnerSubmissionId: winner.id, closesAt: new Date() })
    const late = await createUser(db, { displayName: 'Late' })
    expect((await dbErrorOf(createSubmission(db, submissionInput(round.id, late.id))))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it('lists submissions with like counts and the submitter', async () => {
    const { round, user } = await seedMission(db)
    const grace = await createUser(db, {
      displayName: 'Grace',
      avatarUrl: 'https://example.com/g.png',
    })
    const a = await createSubmission(db, submissionInput(round.id, user.id))
    const b = await createSubmission(db, submissionInput(round.id, grace.id, { x: 60, y: 0 }))
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
    const submission = await createSubmission(db, submissionInput(round.id, user.id))
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
    const submission = await createSubmission(db, submissionInput(round.id, user.id))
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
})
