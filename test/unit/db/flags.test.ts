import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { countActiveUsers, countFlags, flagSegment, hasFlagged } from '#server/repositories/flags'
import { like } from '#server/repositories/likes'
import { openRound } from '#server/repositories/rounds'
import { createSubmission } from '#server/repositories/submissions'
import { createUser } from '#server/repositories/users'
import { createTestDb, dbErrorOf, JOURNEY_T0, seedJourney, submissionInput } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const plus = (ms: number) => new Date(JOURNEY_T0.getTime() + ms)
/** The seeded drive still playing starts four hours in and ends at five. */
const DRIVING = 4 * HOUR

describe('segment flags', () => {
  it('counts distinct users within the window, a second flag moving the first', async () => {
    const { driving } = await seedJourney(db)
    const [bob, cy] = await Promise.all(
      ['Bob', 'Cy'].map((displayName) => createUser(db, { displayName })),
    )
    await flagSegment(db, driving.id, { userId: bob!.id, now: plus(DRIVING + MINUTE) })
    await flagSegment(db, driving.id, { userId: cy!.id, now: plus(DRIVING + 12 * MINUTE) })
    const since = plus(DRIVING + 12 * MINUTE - 10 * MINUTE)
    expect(await countFlags(db, driving.id, { since })).toBe(1)
    expect(await hasFlagged(db, driving.id, { userId: bob!.id, since })).toBe(false)
    // Flagging again counts from now.
    await flagSegment(db, driving.id, { userId: bob!.id, now: plus(DRIVING + 12 * MINUTE) })
    await flagSegment(db, driving.id, { userId: bob!.id, now: plus(DRIVING + 12 * MINUTE) })
    expect(await countFlags(db, driving.id, { since })).toBe(2)
    expect(await hasFlagged(db, driving.id, { userId: bob!.id, since })).toBe(true)
  })

  it('refuses a settled drive, one whose last slice is out, and an unknown one', async () => {
    const { arrival, driving, user } = await seedJourney(db)
    const refused = (segmentId: string, now: Date) =>
      dbErrorOf(flagSegment(db, segmentId, { userId: user.id, now }))
    expect((await refused(arrival.id, plus(DRIVING + MINUTE)))?.code).toBe('INVALID_STATE')
    expect((await refused(driving.id, plus(DRIVING + HOUR)))?.code).toBe('INVALID_STATE')
    expect((await refused('01900000-0000-7000-8000-000000000000', plus(DRIVING)))?.code).toBe(
      'NOT_FOUND',
    )
  })

  it("counts the round's active users: who submitted, LGTMed or flagged, once each", async () => {
    const { mission, reached, driving, user } = await seedJourney(db)
    const [bob, cy, dee] = await Promise.all(
      ['Bob', 'Cy', 'Dee'].map((displayName) => createUser(db, { displayName })),
    )
    const round = await openRound(db, {
      missionId: mission.id,
      fromStopId: reached.id,
      anchor: { x: 5, y: 85 },
    })
    const active = () => countActiveUsers(db, { roundId: round.id, segmentId: driving.id })
    expect(await active()).toBe(0)
    const mine = await createSubmission(db, submissionInput(round, bob!.id, { x: 5, y: 150 }))
    await like(db, mine.id, { userId: cy!.id })
    await flagSegment(db, driving.id, { userId: dee!.id, now: plus(DRIVING + MINUTE) })
    await flagSegment(db, driving.id, { userId: cy!.id, now: plus(DRIVING + MINUTE) })
    expect(await active()).toBe(3)
    // The author of the drive counts only once they act in this round.
    await flagSegment(db, driving.id, { userId: user.id, now: plus(DRIVING + MINUTE) })
    expect(await active()).toBe(4)
  })
})
