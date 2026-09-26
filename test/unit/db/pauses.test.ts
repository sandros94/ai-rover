import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { getActivePause, pauseMission, resumeMission } from '#server/repositories/pauses'
import { createUser } from '#server/repositories/users'
import { createTestDb, dbErrorOf, seedMission } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const T0 = new Date('2026-09-25T12:00:00Z')
const plus = (ms: number) => new Date(T0.getTime() + ms)

describe('mission pauses', () => {
  it('reads the active pause with its message and who paused, until it is resumed', async () => {
    const { mission } = await seedMission(db)
    const op = await createUser(db, { displayName: 'Op', avatarUrl: 'https://example.com/o.png' })
    expect(await getActivePause(db, mission.id)).toBeUndefined()
    await pauseMission(db, mission.id, { message: 'Dust storm.', pausedBy: op.id, at: T0 })
    expect(await getActivePause(db, mission.id)).toEqual({
      message: 'Dust storm.',
      at: T0,
      by: { id: op.id, displayName: 'Op', avatarUrl: 'https://example.com/o.png' },
    })
    await resumeMission(db, mission.id, { at: plus(60_000) })
    expect(await getActivePause(db, mission.id)).toBeUndefined()
    // A later pause is the active one.
    await pauseMission(db, mission.id, { message: 'Again.', pausedBy: op.id, at: plus(120_000) })
    expect((await getActivePause(db, mission.id))?.message).toBe('Again.')
  })

  it('holds at most one active pause per mission, and resumes only an active one', async () => {
    const { mission, user } = await seedMission(db)
    expect((await dbErrorOf(resumeMission(db, mission.id, { at: T0 })))?.code).toBe('INVALID_STATE')
    await pauseMission(db, mission.id, { message: 'One.', pausedBy: user.id, at: T0 })
    expect(
      (
        await dbErrorOf(
          pauseMission(db, mission.id, { message: 'Two.', pausedBy: user.id, at: T0 }),
        )
      )?.code,
    ).toBe('INVALID_STATE')
    // Another mission is not paused.
    expect(await getActivePause(db, (await seedMission(db)).mission.id)).toBeUndefined()
  })
})
