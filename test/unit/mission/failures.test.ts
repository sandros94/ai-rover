import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { getSegment, listDeaths } from '#server/repositories/segments'
import { getStop } from '#server/repositories/stops'
import { createMissionAtStop } from '#server/utils/mission/create'
import { submitGoal } from '#server/utils/mission/submit'
import { tickMission } from '#server/utils/mission/tick'
import type { DriveOutcome } from '#shared/utils/drive'
import { at, createTestDb, fakeJev, memoryStore, MINUTE, T0, users } from './helpers'

/**
 * Outcomes forced onto the next drives, in order: the rover still drives the real terrain, but
 * the record ends as given. Hidden hazards severe enough to fail a drive are rare on default
 * terrain, so failures are injected here.
 */
const forced = vi.hoisted(() => ({ outcomes: [] as ((real: DriveOutcome) => DriveOutcome)[] }))

vi.mock('#shared/utils/drive/segment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/utils/drive/segment')>()
  return {
    ...actual,
    driveSegment: (...args: Parameters<typeof actual.driveSegment>) => {
      const driven = actual.driveSegment(...args)
      const force = forced.outcomes.shift()
      return force
        ? { ...driven, record: { ...driven.record, outcome: force(driven.record.outcome) } }
        : driven
    },
  }
})

vi.setConfig({ testTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

/** A failure with the rover dead at `from + offset`. */
function failAt(from: { x: number; y: number }, offset: { x: number; y: number }) {
  return (real: DriveOutcome): DriveOutcome => ({
    ...real,
    kind: 'failed',
    reasons: ['stuck'],
    endPose: { x: from.x + offset.x, y: from.y + offset.y, headingRad: real.endPose.headingRad },
  })
}

describe('failures', () => {
  it('records the death, retries from the same stop and resets after three clustered strikes', async () => {
    const { store } = memoryStore()
    const { mission, stop: stop0 } = await createMissionAtStop(db, {
      store,
      seed: 'mars',
      at: { x: 0, y: 0 },
      now: T0,
    })
    const missionId = mission.id
    const jev = fakeJev()
    const [ada, bob] = await users(db, 'Ada', 'Bob')
    const submit = (userId: string, goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId, userId, goal, now })
    const tick = (now: Date) => tickMission(db, { store, missionId, now })

    // Stop 1, reached for real.
    await submit(ada!.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const reach = await getSegment(db, (await tick(at(T0, 6 * MINUTE))).started!.segmentId)
    await tick(reach.endsAt)
    const stop1 = await getStop(db, (await getMission(db, missionId)).currentStopId!)
    expect(stop1.index).toBe(1)

    // Three failures from stop 1, their deaths pairwise within 50 m, away from the route east.
    const deaths = [
      { x: -40, y: -40 },
      { x: -45, y: -40 },
      { x: -40, y: -45 },
    ]
    const goal = { x: stop1.x + 80, y: stop1.y }
    const authors = [bob!, ada!, bob!]
    let now = at(reach.endsAt, MINUTE)
    let previous = reach
    for (const [k, death] of deaths.entries()) {
      forced.outcomes.push(failAt(stop1, death))
      const submitted = await submit(authors[k]!.id, goal, now)
      expect(submitted.accepted).toBe(true)
      const started = (await tick(k === 0 ? at(now, 5 * MINUTE) : previous.endsAt)).started!
      const segment = await getSegment(db, started.segmentId)
      expect(segment).toMatchObject({ fromStopId: stop1.id, attempt: k + 1, status: 'driving' })
      // The failure stays private while the drive plays.
      expect(await listDeaths(db, missionId)).toHaveLength(k)
      const next = (await getOpenRound(db, missionId))!
      expect(next.fromStopId).toBe(k < 2 ? stop1.id : stop0.id)
      previous = segment
      now = at(segment.startedAt, MINUTE)
    }

    await tick(previous.endsAt)
    const settled = await getSegment(db, previous.id)
    expect(settled).toMatchObject({
      status: 'failed',
      toStopId: null,
      deathX: stop1.x - 40,
      deathY: stop1.y - 45,
    })
    expect(await listDeaths(db, missionId, { fromStopId: stop1.id })).toHaveLength(3)
    expect((await getMission(db, missionId)).currentStopId).toBe(stop0.id)
    expect((await getOpenRound(db, missionId))!.fromStopId).toBe(stop0.id)
  })

  it('keeps the mission at the stop after a single failure and refuses goals near the death', async () => {
    const { store } = memoryStore()
    const { mission, stop } = await createMissionAtStop(db, {
      store,
      seed: 'mars',
      at: { x: 0, y: 0 },
      now: T0,
    })
    const jev = fakeJev()
    const [ada] = await users(db, 'Ada')
    const submit = (goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId: mission.id, userId: ada!.id, goal, now })
    forced.outcomes.push(failAt(stop, { x: 0, y: 60 }))
    await submit({ x: 0, y: 80 }, at(T0, MINUTE))
    const started = (
      await tickMission(db, { store, missionId: mission.id, now: at(T0, 6 * MINUTE) })
    ).started!
    const segment = await getSegment(db, started.segmentId)
    const settled = await tickMission(db, { store, missionId: mission.id, now: segment.endsAt })
    expect(settled.settled).toEqual({ segmentId: segment.id, status: 'failed' })
    expect((await getMission(db, mission.id)).currentStopId).toBe(stop.id)
    expect((await getOpenRound(db, mission.id))!.fromStopId).toBe(stop.id)

    const later = at(segment.endsAt, MINUTE)
    expect(await submit({ x: 10, y: 75 }, later)).toMatchObject({
      accepted: false,
      reason: 'near-death-zone',
    })
    expect(await submit({ x: 0, y: -80 }, later)).toMatchObject({ accepted: true })
  })
})
