import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { createMission, getMission, setCurrentStop } from '#server/repositories/missions'
import { createStop, getStop, listStops } from '#server/repositories/stops'
import { closeRound, getOpenRound, openRound } from '#server/repositories/rounds'
import { createSubmission, listRoundSubmissions } from '#server/repositories/submissions'
import { createUser } from '#server/repositories/users'
import { CONFIG, createTestDb, dbErrorOf, seedMission, submissionInput } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const MISSING = '01900000-0000-7000-8000-000000000000'

describe('missions', () => {
  it('creates an active mission and reads it back', async () => {
    const mission = await createMission(db, {
      seed: 'gale',
      worldHash: 'fedcba9876543210',
      config: CONFIG,
    })
    expect(mission).toMatchObject({ status: 'active', currentStopId: null, config: CONFIG })
    expect(mission.solsEpoch).toBeInstanceOf(Date)
    expect(await getMission(db, mission.id)).toEqual(mission)
  })

  it('refuses a malformed world hash', async () => {
    await expect(
      createMission(db, { seed: 'x', worldHash: 'not-a-hash', config: CONFIG }),
    ).rejects.toHaveProperty('cause.constraint', 'mission_world_hash_check')
  })

  it('throws NOT_FOUND for an unknown mission', async () => {
    expect((await dbErrorOf(getMission(db, MISSING)))?.code).toBe('NOT_FOUND')
  })

  it('sets the current stop only to a stop of the same mission', async () => {
    const { mission, stop } = await seedMission(db)
    const updated = await setCurrentStop(db, mission.id, stop.id)
    expect(updated.currentStopId).toBe(stop.id)

    const other = await seedMission(db)
    expect((await dbErrorOf(setCurrentStop(db, mission.id, other.stop.id)))?.code).toBe(
      'INVALID_STATE',
    )
    expect((await dbErrorOf(setCurrentStop(db, MISSING, stop.id)))?.code).toBe('NOT_FOUND')
  })
})

describe('stops', () => {
  it('lists stops by index and refuses a duplicate index', async () => {
    const { mission, stop } = await seedMission(db)
    const next = await createStop(db, {
      missionId: mission.id,
      index: 1,
      x: 10,
      y: 80,
      headingRad: 1.5,
      manifestKey: 'terrain/0123456789abcdef/stops/1.json',
      revealedKey: 'terrain/0123456789abcdef/revealed/1.bin',
    })
    expect((await listStops(db, mission.id)).map((s) => s.index)).toEqual([0, 1])
    expect(await getStop(db, next.id)).toEqual(next)
    expect(next.fromSegmentId).toBeNull()
    await expect(
      createStop(db, {
        missionId: mission.id,
        index: stop.index,
        x: 0,
        y: 0,
        headingRad: 0,
        manifestKey: stop.manifestKey,
        revealedKey: stop.revealedKey,
      }),
    ).rejects.toHaveProperty('cause.constraint', 'stop_mission_index_unique')
    expect((await dbErrorOf(getStop(db, MISSING)))?.code).toBe('NOT_FOUND')
  })
})

describe('rounds', () => {
  it('opens one round per mission at a time', async () => {
    const { mission, stop, round } = await seedMission(db)
    expect(round).toMatchObject({ status: 'open', closesAt: null, winnerSubmissionId: null })
    expect(await getOpenRound(db, mission.id)).toEqual(round)
    const error = await dbErrorOf(openRound(db, { missionId: mission.id, fromStopId: stop.id }))
    expect(error?.code).toBe('INVALID_STATE')
  })

  it('closes with a winner, settles the other open submissions, and allows a new round', async () => {
    const { mission, stop, round, user } = await seedMission(db)
    const rival = await createUser(db, { displayName: 'Rival' })
    const winner = await createSubmission(db, submissionInput(round.id, user.id))
    const loser = await createSubmission(db, submissionInput(round.id, rival.id))
    const closesAt = new Date('2026-09-25T13:00:00Z')
    const closed = await closeRound(db, round.id, { winnerSubmissionId: winner.id, closesAt })
    expect(closed).toMatchObject({ status: 'closed', winnerSubmissionId: winner.id, closesAt })
    const statuses = Object.fromEntries(
      (await listRoundSubmissions(db, round.id)).map((s) => [s.id, s.status]),
    )
    expect(statuses).toEqual({ [winner.id]: 'won', [loser.id]: 'lost' })
    expect(await getOpenRound(db, mission.id)).toBeUndefined()

    // A retry from the same stop after a failure opens a second round from it.
    const retry = await openRound(db, { missionId: mission.id, fromStopId: stop.id })
    expect(retry.status).toBe('open')
  })

  it('refuses to close with a winner from another round or twice', async () => {
    const a = await seedMission(db)
    const b = await seedMission(db)
    const foreign = await createSubmission(db, submissionInput(b.round.id, b.user.id))
    const closesAt = new Date()
    expect(
      (await dbErrorOf(closeRound(db, a.round.id, { winnerSubmissionId: foreign.id, closesAt })))
        ?.code,
    ).toBe('INVALID_STATE')
    await closeRound(db, b.round.id, { winnerSubmissionId: foreign.id, closesAt })
    expect(
      (await dbErrorOf(closeRound(db, b.round.id, { winnerSubmissionId: foreign.id, closesAt })))
        ?.code,
    ).toBe('INVALID_STATE')
    expect(
      (await dbErrorOf(closeRound(db, MISSING, { winnerSubmissionId: foreign.id, closesAt })))
        ?.code,
    ).toBe('NOT_FOUND')
  })

  it('refuses a round from a stop of another mission', async () => {
    const a = await seedMission(db)
    const b = await seedMission(db)
    await closeRound(db, a.round.id, {
      winnerSubmissionId: (await createSubmission(db, submissionInput(a.round.id, a.user.id))).id,
      closesAt: new Date(),
    })
    const error = await dbErrorOf(openRound(db, { missionId: a.mission.id, fromStopId: b.stop.id }))
    expect(error?.code).toBe('INVALID_STATE')
  })
})
