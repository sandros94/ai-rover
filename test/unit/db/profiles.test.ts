import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { getPublicProfile } from '#server/repositories/profiles'
import { like } from '#server/repositories/likes'
import { openRound } from '#server/repositories/rounds'
import { createSubmission, withdrawSubmission } from '#server/repositories/submissions'
import { createUser } from '#server/repositories/users'
import { createTestDb, dbErrorOf, seedJourney, submissionInput } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('public profiles', () => {
  it("lists the user's standing submissions newest first, a playing drive without its ending", async () => {
    const { mission, reached, user } = await seedJourney(db)
    const round = await openRound(db, {
      missionId: mission.id,
      fromStopId: reached.id,
      anchor: reached,
    })
    const open = await createSubmission(db, submissionInput(round, user.id, { x: 20, y: 90 }))
    const fan = await createUser(db, { displayName: 'Fan' })
    await like(db, open.id, { userId: fan.id })
    const other = await createUser(db, { displayName: 'Other' })
    const theirs = await createSubmission(db, submissionInput(round, other.id))
    await withdrawSubmission(db, theirs.id, { userId: other.id })

    const profile = await getPublicProfile(db, user.id)
    expect(profile.user).toMatchObject({ id: user.id, displayName: 'Ada', providers: [] })
    expect(profile.submissions.map((s) => [s.round, s.status, s.drive])).toEqual([
      [4, 'open', null],
      [3, 'won', { status: 'driving' }],
      [2, 'won', { status: 'failed', distanceM: 42 }],
      [1, 'won', { status: 'arrived', distanceM: 80 }],
    ])
    expect(profile.submissions[0]).toMatchObject({ likes: 2, ownLike: true, goalDistanceM: 80 })
    expect((await getPublicProfile(db, other.id)).submissions).toEqual([])
  })

  it('answers NOT_FOUND for an unknown user', async () => {
    const error = await dbErrorOf(getPublicProfile(db, '01900000-0000-7000-8000-000000000000'))
    expect(error?.code).toBe('NOT_FOUND')
  })
})
