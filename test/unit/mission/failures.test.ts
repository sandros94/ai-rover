import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { getMission } from '#server/repositories/missions'
import { getOpenRound, getRound } from '#server/repositories/rounds'
import { getSegment, listDeaths } from '#server/repositories/segments'
import { getStop } from '#server/repositories/stops'
import { getSubmission } from '#server/repositories/submissions'
import { createMissionAtStop } from '#server/utils/mission/create'
import { publicMissionState } from '#server/utils/mission/state'
import { submitGoal } from '#server/utils/mission/submit'
import { tickMission } from '#server/utils/mission/tick'
import { failAt, forced } from './forced'
import { at, createTestDb, fakeJev, memoryStore, MINUTE, T0, users } from './helpers'

vi.mock('#shared/utils/drive/segment', async (original) =>
  (await import('./forced')).forcedDriveSegment(original),
)

vi.setConfig({ testTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

async function landed() {
  const { store } = memoryStore()
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    now: T0,
  })
  const missionId = created.mission.id
  const jev = fakeJev()
  const [ada, bob, cy] = await users(db, 'Ada', 'Bob', 'Cy')
  return {
    ...created,
    missionId,
    store,
    ada: ada!,
    bob: bob!,
    cy: cy!,
    submit: (userId: string, goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId, userId, goal, now }),
    tick: (now: Date) => tickMission(db, { store, jev: jev.client, missionId, now }),
  }
}

describe('failures', () => {
  it('records the death, retries from the same stop and resets after three clustered strikes', async () => {
    const m = await landed()

    // Stop 1, reached for real.
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const reach = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    await m.tick(reach.endsAt)
    const stop1 = await getStop(db, (await getMission(db, m.missionId)).currentStopId!)
    expect(stop1.index).toBe(1)

    // Three failures from stop 1, their deaths pairwise within 50 m, away from the route east.
    const deaths = [
      { x: -40, y: -40 },
      { x: -45, y: -40 },
      { x: -40, y: -45 },
    ]
    const goal = { x: stop1.x + 80, y: stop1.y }
    const authors = [m.bob, m.ada, m.bob]
    let now = at(reach.endsAt, MINUTE)
    let last = reach
    const failures: (typeof reach)[] = []
    for (const [k, death] of deaths.entries()) {
      forced.outcomes.push(failAt(stop1, death))
      const submitted = await m.submit(authors[k]!.id, goal, now)
      expect(submitted.accepted).toBe(true)
      const { goalX, goalY } = submitted.submission!
      const started = (await m.tick(at(now, 5 * MINUTE))).started!
      const segment = await getSegment(db, started.segmentId)
      expect(segment).toMatchObject({ fromStopId: stop1.id, attempt: k + 1, status: 'driving' })
      // The failure stays private while the drive plays: the next round waits at the goal.
      expect(await listDeaths(db, m.missionId)).toHaveLength(k)
      const playing = await publicMissionState(db, {
        missionId: m.missionId,
        now: segment.startedAt,
      })
      expect(playing.deaths.map(({ x, y }) => ({ x, y }))).toEqual(
        deaths.slice(0, k).map((d) => ({ x: stop1.x + d.x, y: stop1.y + d.y })),
      )
      const next = (await getOpenRound(db, m.missionId))!
      expect(next).toMatchObject({ fromStopId: stop1.id, anchorX: goalX, anchorY: goalY })

      const settled = await m.tick(segment.endsAt)
      expect(settled.settled).toEqual({ segmentId: segment.id, status: 'failed' })
      const after = await publicMissionState(db, { missionId: m.missionId, now: segment.endsAt })
      // A settled death names its segment, why and when it ended and how far it drove.
      expect(after.deaths.at(-1)).toEqual({
        x: stop1.x + death.x,
        y: stop1.y + death.y,
        segmentId: segment.id,
        number: 2 + k,
        fromIndex: 1,
        reasons: ['stuck'],
        at: segment.endsAt,
        distanceM: segment.outcome!.distanceM,
      })
      // A stop names the segment that reached it and when; the landing stop has none.
      expect(after.trail).toEqual([
        { index: 0, x: m.stop.x, y: m.stop.y, reachedBy: null },
        {
          index: 1,
          x: stop1.x,
          y: stop1.y,
          reachedBy: { segmentId: reach.id, number: 1, fromIndex: 0, at: reach.endsAt },
        },
      ])
      expect(await getRound(db, next.id)).toMatchObject({
        status: 'void',
        winnerSubmissionId: null,
      })
      last = segment
      failures.push(segment)
      now = at(segment.endsAt, MINUTE)
    }

    expect(await getSegment(db, last.id)).toMatchObject({
      status: 'failed',
      toStopId: null,
      deathX: stop1.x - 40,
      deathY: stop1.y - 45,
    })
    expect(await listDeaths(db, m.missionId, { fromStopId: stop1.id })).toHaveLength(3)
    const stop0 = m.stop
    expect((await getMission(db, m.missionId)).currentStopId).toBe(stop0.id)
    expect(await getOpenRound(db, m.missionId)).toMatchObject({
      fromStopId: stop0.id,
      anchorX: stop0.x,
      anchorY: stop0.y,
    })
    const state = await publicMissionState(db, { missionId: m.missionId, now: last.endsAt })
    expect(state.tally).toEqual({
      distanceM: [reach, ...failures].reduce((sum, s) => sum + s.outcome!.distanceM, 0),
      stops: 2,
      arrived: 1,
      stoppedShort: 0,
      failed: 3,
      resets: 1,
      longestM: Math.max(...[reach, ...failures].map((s) => s.outcome!.distanceM)),
    })
    expect(state.lastSegment).toEqual({
      id: last.id,
      status: 'failed',
      startedAt: last.startedAt,
      endsAt: last.endsAt,
      fromStopId: stop1.id,
      distanceM: last.outcome!.distanceM,
    })
  })

  it('voids the round beside a failed drive: its open submissions are lost, a fresh round opens', async () => {
    const m = await landed()
    forced.outcomes.push(failAt(m.stop, { x: 0, y: 60 }))
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const started = (await m.tick(at(T0, 6 * MINUTE))).started!
    const segment = await getSegment(db, started.segmentId)
    const beside = (await getOpenRound(db, m.missionId))!
    const waiting = await m.submit(m.bob.id, { x: 80, y: 80 }, at(T0, 10 * MINUTE))
    expect(waiting.accepted).toBe(true)

    const tick = await m.tick(segment.endsAt)
    expect(tick.settled).toEqual({ segmentId: segment.id, status: 'failed' })
    // Nothing wins a voided round, so nothing starts.
    expect(tick.closed).toBeNull()
    expect(tick.started).toBeNull()
    expect(await getRound(db, beside.id)).toMatchObject({
      status: 'void',
      winnerSubmissionId: null,
      closesAt: segment.endsAt,
    })
    expect((await getSubmission(db, waiting.submission!.id)).status).toBe('lost')
    const fresh = (await getOpenRound(db, m.missionId))!
    expect(fresh.id).not.toBe(beside.id)
    expect(fresh).toMatchObject({ fromStopId: m.stop.id, anchorX: 0, anchorY: 0 })
    expect(tick.opened).toEqual({ roundId: fresh.id })
    expect((await getMission(db, m.missionId)).currentStopId).toBe(m.stop.id)

    const later = at(segment.endsAt, MINUTE)
    expect(await m.submit(m.bob.id, { x: 10, y: 75 }, later)).toMatchObject({
      accepted: false,
      reason: 'near-death-zone',
    })
    expect(await m.submit(m.bob.id, { x: 0, y: -80 }, later)).toMatchObject({ accepted: true })
  })
})
