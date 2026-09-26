import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { listCommunityTallies } from '#server/repositories/community'
import { like } from '#server/repositories/likes'
import { openRound } from '#server/repositories/rounds'
import { createSubmission } from '#server/repositories/submissions'
import { createUser } from '#server/repositories/users'
import { createTestDb, seedJourney, seedMission, submissionInput } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('listCommunityTallies', () => {
  it("tallies each submitter's settled drives and the LGTMs others gave, by distance", async () => {
    const { mission, reached, user } = await seedJourney(db)
    const grace = await createUser(db, { displayName: 'Grace', avatarUrl: 'https://g.test/a.png' })
    const round = await openRound(db, {
      missionId: mission.id,
      fromStopId: reached.id,
      anchor: { x: 5, y: 85 },
    })
    const picked = await createSubmission(db, submissionInput(round, grace.id, { x: 5, y: 150 }))
    await like(db, picked.id, { userId: user.id })
    // Users of other missions stay out.
    await seedMission(db)

    expect(await listCommunityTallies(db, mission.id)).toEqual([
      {
        user: { id: user.id, displayName: 'Ada', avatarUrl: null },
        // The arrival and the failure; the drive still playing is not settled.
        won: 2,
        distanceM: 80 + 42,
        failures: 1,
        // Its own LGTMs are not received.
        lgtmsReceived: 0,
      },
      {
        user: { id: grace.id, displayName: 'Grace', avatarUrl: 'https://g.test/a.png' },
        won: 0,
        distanceM: 0,
        failures: 0,
        lgtmsReceived: 1,
      },
    ])
  })
})
