import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { like } from '#server/repositories/likes'
import { getMission } from '#server/repositories/missions'
import { getOpenRound, getRound } from '#server/repositories/rounds'
import { getSegment } from '#server/repositories/segments'
import { getSubmission, withdrawSubmission } from '#server/repositories/submissions'
import { createMissionAtStop } from '#server/utils/mission/create'
import { submitGoal } from '#server/utils/mission/submit'
import { tickMission } from '#server/utils/mission/tick'
import { DriveError } from '#shared/utils/drive'
import { NavError } from '#shared/utils/nav'
import { forced, stopShortAt } from './forced'
import { at, createTestDb, fakeJev, memoryStore, MINUTE, T0, users } from './helpers'

vi.mock('#shared/utils/drive/segment', async (original) =>
  (await import('./forced')).forcedDriveSegment(original),
)

vi.setConfig({ testTimeout: 60_000 })

/** SQL of every query run, in order; tests slice it around the call they look at. */
const queries: string[] = []
/** Top-level transactions and Jev requests, in the order they happened. */
const events: ('begin' | 'end' | 'jev')[] = []

let raw: DB
let db: DB
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db: raw, close } = await createTestDb({ onQuery: (sql) => queries.push(sql) }))
  // The same database, recording where each top-level transaction begins and ends.
  db = new Proxy(raw, {
    get(target, prop) {
      if (prop === 'transaction') {
        return async (...args: Parameters<DB['transaction']>) => {
          events.push('begin')
          try {
            return await target.transaction(...args)
          } finally {
            events.push('end')
          }
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
})
afterAll(() => close())

type Judge = NonNullable<Parameters<typeof fakeJev>[0]>

async function landed(judge: Judge = () => ({})) {
  const { store } = memoryStore()
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    now: T0,
  })
  const missionId = created.mission.id
  const jev = fakeJev(async (summary) => {
    events.push('jev')
    return judge(summary)
  })
  const [ada, bob, cy, dee] = await users(db, 'Ada', 'Bob', 'Cy', 'Dee')
  return {
    ...created,
    missionId,
    store,
    jev,
    ada: ada!,
    bob: bob!,
    cy: cy!,
    dee: dee!,
    submit: (userId: string, goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId, userId, goal, now }),
    tick: (now: Date) => tickMission(db, { store, jev: jev.client, missionId, now }),
  }
}

/** A drive from the landing stop to (0, 80) that stops short at (0, 40), with two goals waiting. */
async function stoppingShort(judge?: Judge) {
  const m = await landed(judge)
  forced.outcomes.push(stopShortAt({ x: 0, y: 40 }))
  await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
  const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
  const beside = (await getOpenRound(db, m.missionId))!
  const during = at(T0, 10 * MINUTE)
  const east = await m.submit(m.bob.id, { x: 80, y: 80 }, during)
  const west = await m.submit(m.cy.id, { x: -80, y: 80 }, during)
  expect(east.accepted && west.accepted).toBe(true)
  return { ...m, driving, beside, east: east.submission!, west: west.submission! }
}

describe('settling a drive that stopped short', () => {
  it('asks Jev nothing inside a transaction', async () => {
    const m = await stoppingShort()
    events.length = 0
    const tick = await m.tick(m.driving.endsAt)
    expect(tick.settled).toEqual({ segmentId: m.driving.id, status: 'stopped-short' })
    expect(events.filter((e) => e === 'jev')).toHaveLength(2)
    // How many transactions were open at each Jev request.
    let depth = 0
    const open: number[] = []
    for (const event of events) {
      if (event === 'begin') depth++
      else if (event === 'end') depth--
      else open.push(depth)
    }
    expect(open).toEqual([0, 0])
  })

  it('keeps settling when a waiting submission is withdrawn while it is judged again', async () => {
    let settling = false
    let withdraw: (() => Promise<unknown>) | undefined
    const m = await stoppingShort(async () => {
      if (settling) {
        // The first re-judgment withdraws the other waiting goal, as its author might then.
        const run = withdraw
        withdraw = undefined
        await run?.()
      }
      return {}
    })
    withdraw = () => withdrawSubmission(db, m.west.id, { userId: m.cy.id })
    settling = true
    const tick = await m.tick(m.driving.endsAt)
    expect(tick.settled).toEqual({ segmentId: m.driving.id, status: 'stopped-short' })
    expect(await getRound(db, m.beside.id)).toMatchObject({ anchorX: 0, anchorY: 40 })
    expect((await getSubmission(db, m.west.id)).status).toBe('withdrawn')
    // The other goal was revised from the stop reached and won the round.
    const east = await getSubmission(db, m.east.id)
    expect(east.metrics.straightLineM).toBeCloseTo(Math.hypot(80, 40), 9)
    expect(east.status).toBe('won')
  })

  it('rejects a goal submitted while the others were judged again, planned from the old anchor', async () => {
    let late: (() => Promise<unknown>) | undefined
    const m = await stoppingShort(async () => {
      const run = late
      late = undefined
      await run?.()
      return {}
    })
    let lateId: string | undefined
    late = async () => {
      const result = await m.submit(m.dee.id, { x: 0, y: 160 }, at(m.driving.endsAt, -1))
      lateId = result.submission?.id
    }
    const tick = await m.tick(m.driving.endsAt)
    expect(tick.settled?.status).toBe('stopped-short')
    expect(lateId).toBeDefined()
    expect(await getSubmission(db, lateId!)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'invalidated-by-stop',
    })
  })
})

describe('starting the winner', () => {
  it('rejects a winner whose drive cannot be computed and starts the next ranked', async () => {
    const m = await landed()
    const first = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const second = await m.submit(m.bob.id, { x: -80, y: 80 }, at(T0, 2 * MINUTE))
    await like(db, first.submission!.id, { userId: m.cy.id })
    forced.errors.push(new NavError('OUT_OF_DISK', 'The goal lies beyond the disk.'))
    const tick = await m.tick(at(T0, 6 * MINUTE))
    expect(tick.closed).toEqual({ roundId: m.round.id, winnerSubmissionId: second.submission!.id })
    expect(await getSubmission(db, first.submission!.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'invalidated-by-stop',
    })
    expect(await getSegment(db, tick.started!.segmentId)).toMatchObject({
      submissionId: second.submission!.id,
      fromStopId: m.stop.id,
    })
  })

  it('voids the round and opens a fresh one from the same stop when no candidate drives', async () => {
    const m = await landed()
    const only = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    forced.errors.push(new DriveError('INVALID_INPUT', 'The start pose is off the disk.'))
    const now = at(T0, 6 * MINUTE)
    const tick = await m.tick(now)
    expect(tick).toMatchObject({ settled: null, closed: null, started: null })
    expect(await getRound(db, m.round.id)).toMatchObject({
      status: 'void',
      winnerSubmissionId: null,
    })
    expect(await getSubmission(db, only.submission!.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'invalidated-by-stop',
    })
    const fresh = (await getOpenRound(db, m.missionId))!
    expect(tick.opened).toEqual({ roundId: fresh.id })
    expect(fresh).toMatchObject({ fromStopId: m.stop.id, anchorX: 0, anchorY: 0, opensAt: now })
    // The mission carries on: the user may submit again in the fresh round.
    expect((await m.submit(m.ada.id, { x: 0, y: 80 }, at(now, MINUTE))).accepted).toBe(true)
  })
})

describe('closing a round', () => {
  it('locks the round for update before reading the standings it closes on', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    queries.length = 0
    expect((await m.tick(at(T0, 6 * MINUTE))).closed).not.toBeNull()
    const lock = queries.findIndex((q) => /from "round".* for update/s.test(q))
    const standings = queries.findIndex((q) => /"submission_like"/.test(q))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(standings).toBeGreaterThan(lock)
  })

  it('has a like share-lock the round, so a like waits for a closing round or is counted', async () => {
    const m = await landed()
    const { submission } = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    queries.length = 0
    await like(db, submission!.id, { userId: m.bob.id })
    expect(queries.some((q) => /"round"/.test(q) && / for share/.test(q))).toBe(true)
  })
})

describe('the next due instant', () => {
  it('follows what the next tick has to do: a grace window, a drive end, then nothing', async () => {
    const m = await landed()
    const due = async () => (await getMission(db, m.missionId)).nextDueAt
    expect(await due()).toBeNull()
    await m.tick(at(T0, MINUTE))
    expect(await due()).toBeNull()

    // The first submission opens the grace window.
    const submittedAt = at(T0, 2 * MINUTE)
    await m.submit(m.ada.id, { x: 0, y: 80 }, submittedAt)
    expect(await due()).toEqual(at(submittedAt, 5 * MINUTE))

    const started = (await m.tick(at(submittedAt, 5 * MINUTE))).started!
    const driving = await getSegment(db, started.segmentId)
    expect(await due()).toEqual(driving.endsAt)

    await m.tick(driving.endsAt)
    expect(await due()).toBeNull()
  })
})
