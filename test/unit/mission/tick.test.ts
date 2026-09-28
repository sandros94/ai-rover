import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { DbError } from '#server/database/errors'
import { like } from '#server/repositories/likes'
import { getMission } from '#server/repositories/missions'
import { getOpenRound, getRound } from '#server/repositories/rounds'
import { getDrivingSegment, getSegment } from '#server/repositories/segments'
import { listStops } from '#server/repositories/stops'
import { flagSegment } from '#server/repositories/flags'
import { countLikes } from '#server/repositories/likes'
import { getSubmission, withdrawSubmission } from '#server/repositories/submissions'
import { createMissionAtStop } from '#server/utils/mission/create'
import { publicMissionState } from '#server/utils/mission/state'
import { submitGoal } from '#server/utils/mission/submit'
import { createJevClient, JEV_SERVER_LIMITS } from '#server/utils/jev/client'
import { JudgeError } from '#server/utils/jev/errors'
import { httpErrorOf } from '#server/utils/mission/http'
import { tickMission } from '#server/utils/mission/tick'
import { stopPrimeKeys } from '#server/utils/journey/prime'
import type { JourneyStore } from '#server/utils/journey/store'
import { decodeSlice, DriveError, segmentSliceKey } from '#shared/utils/drive'
import { NavError } from '#shared/utils/nav'
import { memoryJevCache } from '../jev/helpers'
import { forced, stopShortAt } from './forced'
import {
  at,
  createTestDb,
  fakeJev,
  memoryStore,
  MINUTE,
  syntheticRecord,
  T0,
  users,
} from './helpers'

vi.mock('#shared/utils/drive/segment', async (original) =>
  (await import('./forced')).forcedDriveSegment(original),
)

vi.setConfig({ testTimeout: 60_000 })

/** SQL of every query run, in order; tests slice it around the call they look at. */
const queries: string[] = []
/** Top-level transactions, Jev requests and CDN priming requests, in the order they happened. */
const events: ('begin' | 'end' | 'jev' | 'prime' | 'put')[] = []
/** Runs before every blob write of a mission's store, with the key written. */
let onPut: ((key: string) => unknown) | undefined
afterEach(() => {
  onPut = undefined
})

/** `store`, calling {@link onPut} before each write. */
function hooked(store: JourneyStore): JourneyStore {
  return {
    ...store,
    putImmutable: async (key, bytes, options) => {
      await onPut?.(key)
      return store.putImmutable(key, bytes, options)
    },
    putJson: async (key, value) => {
      await onPut?.(key)
      return store.putJson(key, value)
    },
  }
}

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
  const store = hooked(memoryStore().store)
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

describe('priming the CDN', () => {
  it('requests the stop reached once its settlement commits, and nothing of a drive', async () => {
    const primed: string[] = []
    vi.stubEnv('URL', 'https://rover.example')
    vi.stubGlobal('fetch', async (url: string) => {
      events.push('prime')
      primed.push(url)
      return new Response(null)
    })
    try {
      const m = await stoppingShort()
      // Landing primes stop 0; starting a drive primes nothing.
      expect(primed).toEqual(
        stopPrimeKeys(m.missionId, 0).map((key) => `https://rover.example/journey/${key}`),
      )
      primed.length = 0
      events.length = 0
      await m.tick(m.driving.endsAt)
      await vi.waitFor(() => expect(primed).toHaveLength(3))
      expect(primed).toEqual(
        stopPrimeKeys(m.missionId, 1).map((key) => `https://rover.example/journey/${key}`),
      )
      // After the settlement's transaction; the close it made due runs in a second one.
      expect(events.indexOf('prime')).toBeGreaterThan(events.indexOf('end'))
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })
})

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
      else if (event === 'jev') open.push(depth)
    }
    expect(open).toEqual([0, 0])
  })

  it('fails as UPSTREAM, before any transaction, when a re-judgment never answers', async () => {
    const m = await stoppingShort()
    // A request that never answers, as fetch does until it is aborted.
    let requests = 0
    const silent = (_input: string, init?: RequestInit) => (
      requests++,
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    )
    const jev = createJevClient({
      apiKey: 'k',
      fetch: silent,
      cache: memoryJevCache().cache,
      ...JEV_SERVER_LIMITS,
    })
    events.length = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const failure = tickMission(db, {
        store: m.store,
        jev,
        missionId: m.missionId,
        now: m.driving.endsAt,
      }).catch((error: unknown) => error)
      let settled = false
      void failure.then(() => (settled = true))
      // The clock moves only once Jev is asked and between real I/O turns, so every query still
      // answers; bounded by every attempt and the backoff between them.
      const limit = (JEV_SERVER_LIMITS.maxRetries + 1) * JEV_SERVER_LIMITS.timeoutMs + 10_000
      let waited = 0
      while (!settled && waited <= limit) {
        await new Promise((resolve) => setImmediate(resolve))
        if (requests === 0) continue
        await vi.advanceTimersByTimeAsync(500)
        waited += 500
      }
      const error = await failure
      expect(error).toBeInstanceOf(JudgeError)
      expect((error as JudgeError).code).toBe('UPSTREAM')
      // One attempt and one retry, each given up at the timeout.
      expect(requests).toBe(JEV_SERVER_LIMITS.maxRetries + 1)
      expect(waited).toBeGreaterThanOrEqual(requests * JEV_SERVER_LIMITS.timeoutMs)
    } finally {
      vi.useRealTimers()
    }
    expect(events).not.toContain('begin')
    expect((await getSegment(db, m.driving.id)).status).toBe('driving')
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
    const standings = queries.findIndex((q, k) => k > lock && /"submission_like"/.test(q))
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

describe('the author of the drive in progress', () => {
  /** Ada's drive to (0, 80) playing, and the round beside it. */
  async function adaDriving() {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    return { ...m, driving, during: at(T0, 10 * MINUTE) }
  }

  it('may submit, starting with their own LGTM, and ranks after everyone else', async () => {
    const m = await adaDriving()
    const mine = await m.submit(m.ada.id, { x: 0, y: 160 }, m.during)
    expect(mine.accepted).toBe(true)
    expect(await countLikes(db, mine.submission!.id)).toBe(1)
    const other = await m.submit(m.bob.id, { x: 80, y: 80 }, m.during)
    await like(db, mine.submission!.id, { userId: m.cy.id })
    await like(db, mine.submission!.id, { userId: m.dee.id })

    const state = await publicMissionState(db, { missionId: m.missionId, now: m.during })
    const deferred = Object.fromEntries(state.round!.submissions.map((s) => [s.id, s.deferred]))
    expect(deferred).toEqual({ [mine.submission!.id]: true, [other.submission!.id]: false })

    const tick = await m.tick(m.driving.endsAt)
    expect(tick.closed?.winnerSubmissionId).toBe(other.submission!.id)
  })

  it('wins when nobody else submitted during the drive', async () => {
    const m = await adaDriving()
    const mine = await m.submit(m.ada.id, { x: 0, y: 160 }, m.during)
    const tick = await m.tick(m.driving.endsAt)
    expect(tick.closed?.winnerSubmissionId).toBe(mine.submission!.id)
  })
})

describe('a drive that stops moving', () => {
  const SLICE_MS = 30_000

  /**
   * Ada's drive replaced by a record that moves at 0.1 m/s for 20 minutes, then stands still
   * until the hour, so the backstop cuts it at 2100 s; Bob waits in the round beside it.
   */
  async function stalling() {
    const m = await landed()
    forced.records.push((real) =>
      syntheticRecord({ start: real.start, stopAfterS: 1200, durationS: 3600 }),
    )
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    const beside = (await getOpenRound(db, m.missionId))!
    await m.submit(m.bob.id, { x: 80, y: 80 }, at(driving.startedAt, MINUTE))
    const flag = (userId: string, afterStartMs: number) =>
      flagSegment(db, driving.id, { userId, now: at(driving.startedAt, afterStartMs) })
    return { ...m, driving, beside, flag, start: driving.outcome!.endPose }
  }

  it('fails at the last released pose once the quorum flags a window without progress', async () => {
    const m = await stalling()
    const now = at(m.driving.startedAt, 1815_000)
    await m.flag(m.cy.id, 1800_000)
    const state = await publicMissionState(db, { missionId: m.missionId, now })
    // Bob, Cy active: a quorum of two.
    expect(state.flags).toEqual({ count: 1, quorum: 2 })
    expect((await m.tick(now)).settled).toBeNull()
    expect((await getSegment(db, m.driving.id)).endsAt).toEqual(m.driving.endsAt)

    await m.flag(m.dee.id, 1810_000)
    await m.tick(now)
    // Slices 0 … 59 are out at 1815 s; slice 60 now ends the drive, released at 1830 s.
    const voided = await getSegment(db, m.driving.id)
    expect(voided.status).toBe('driving')
    expect(voided.endsAt).toEqual(at(m.driving.startedAt, 61 * SLICE_MS))
    expect(voided.outcome).toMatchObject({
      kind: 'failed',
      reasons: ['flagged-not-moving'],
      durationS: 1800,
    })
    const last = decodeSlice((await m.store.getInflated(segmentSliceKey(m.driving.id, 60)))!)
    expect(last.outcome).toEqual(voided.outcome)
    expect(await m.store.has(segmentSliceKey(m.driving.id, 59))).toBe(true)
    expect(await m.store.has(segmentSliceKey(m.driving.id, 61))).toBe(false)
    expect(await m.store.has(segmentSliceKey(m.driving.id, 119))).toBe(false)

    const settled = await m.tick(voided.endsAt)
    expect(settled.settled).toEqual({ segmentId: m.driving.id, status: 'failed' })
    const after = await publicMissionState(db, { missionId: m.missionId, now: voided.endsAt })
    expect(after.deaths.at(-1)!.x).toBeCloseTo(voided.outcome!.endPose.x, 3)
    expect((await getRound(db, m.beside.id)).status).toBe('void')
    expect(after.flags).toBeNull()
  })

  it('keeps driving while the flagged window still shows progress', async () => {
    const m = await stalling()
    await m.flag(m.cy.id, 1400_000)
    await m.flag(m.dee.id, 1400_000)
    await m.tick(at(m.driving.startedAt, 1500_000))
    expect(await getSegment(db, m.driving.id)).toEqual(m.driving)
  })

  it('fails the drive without flags once the record shows no progress over the backstop', async () => {
    const m = await landed()
    forced.records.push((real) =>
      syntheticRecord({ start: real.start, stopAfterS: 1200, durationS: 3600 }),
    )
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    // At the release of slice 69 (2100 s) the frames up to 2099.5 s show 0.05 m over 900 s.
    expect(driving.endsAt).toEqual(at(driving.startedAt, 71 * SLICE_MS))
    expect(driving.outcome).toMatchObject({ kind: 'failed', reasons: ['no-progress'] })
    expect(await m.store.has(segmentSliceKey(driving.id, 70))).toBe(true)
    expect(await m.store.has(segmentSliceKey(driving.id, 71))).toBe(false)
    expect((await m.tick(driving.endsAt)).settled?.status).toBe('failed')
  })
})

describe('the mission lock', () => {
  /** How many transactions were open at each blob write, in order. */
  function depthAtPuts(): number[] {
    let depth = 0
    const at: number[] = []
    for (const event of events) {
      if (event === 'begin') depth++
      else if (event === 'end') depth--
      else if (event === 'put') at.push(depth)
    }
    return at
  }

  it('publishes the stop reached and the next drive before taking it', async () => {
    const m = await stoppingShort()
    events.length = 0
    onPut = () => events.push('put')
    const tick = await m.tick(m.driving.endsAt)
    expect(tick.settled?.status).toBe('stopped-short')
    expect(tick.started).not.toBeNull()
    // The stop's blobs before the settlement's transaction, the drive's before the close's.
    const [settling, closing] = [events.indexOf('begin'), events.lastIndexOf('begin')]
    expect(closing).toBeGreaterThan(settling)
    expect(events.slice(0, settling)).toContain('put')
    expect(events.slice(events.indexOf('end'), closing)).toContain('put')
    expect(depthAtPuts().every((depth) => depth === 0)).toBe(true)
  })

  it('drops a prepared close whose ranking changed meanwhile, writing nothing, and redoes it', async () => {
    const m = await landed()
    const first = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const second = await m.submit(m.bob.id, { x: -80, y: 80 }, at(T0, 2 * MINUTE))
    // While Ada's drive is published, a like puts Bob's goal ahead.
    let liked = false
    onPut = async (key) => {
      if (liked || !key.startsWith('segments/')) return
      liked = true
      await like(db, second.submission!.id, { userId: m.cy.id })
    }
    const now = at(T0, 6 * MINUTE)
    const tick = await m.tick(now)
    expect(liked).toBe(true)
    expect(tick).toEqual({
      settled: null,
      closed: null,
      started: null,
      opened: null,
      skipped: 'changed',
    })
    expect(await getRound(db, m.round.id)).toMatchObject({ status: 'open' })
    expect(await getDrivingSegment(db, m.missionId)).toBeUndefined()
    for (const { submission } of [first, second]) {
      expect((await getSubmission(db, submission!.id)).status).toBe('open')
    }
    // Still due, so the next tick prepares again and closes on the ranking as it stands.
    expect((await getMission(db, m.missionId)).nextDueAt!.getTime()).toBeLessThanOrEqual(
      now.getTime(),
    )
    const again = await m.tick(now)
    expect(again.closed).toEqual({
      roundId: m.round.id,
      winnerSubmissionId: second.submission!.id,
    })
  })

  it('applies nothing when another tick settled the drive while this one prepared it', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    let meanwhile: Awaited<ReturnType<typeof m.tick>> | undefined
    onPut = async (key) => {
      if (meanwhile || !key.startsWith(`missions/${m.missionId}/`)) return
      onPut = undefined
      meanwhile = await m.tick(driving.endsAt)
    }
    const tick = await m.tick(driving.endsAt)
    expect(meanwhile?.settled).toEqual({ segmentId: driving.id, status: 'arrived' })
    expect(tick).toMatchObject({ settled: null, closed: null, started: null, opened: null })
    expect((await listStops(db, m.missionId)).map((stop) => stop.index)).toEqual([0, 1])
  })

  /**
   * `db`, whose transactions answer `lock` for the mission lock statement instead of running it:
   * the in-memory database is a single session, so a lock held elsewhere cannot be staged.
   */
  function contended(lock: (statement: string) => unknown): DB {
    const dialect = new PgDialect()
    const wrap = (tx: DB) =>
      new Proxy(tx, {
        get(target, prop) {
          if (prop !== 'execute') {
            const value = Reflect.get(target, prop, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (query: SQL) => {
            const statement = dialect.sqlToQuery(query).sql
            if (/pg_(try_)?advisory_xact_lock/.test(statement)) return lock(statement)
            return target.execute(query)
          }
        },
      })
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (apply: (tx: DB) => Promise<unknown>) =>
            target.transaction((tx) => apply(wrap(tx as unknown as DB)))
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /** A lock wait past `lock_timeout`, as the driver reports it. */
  function lockTimeout(): Error {
    const cause = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    })
    return new Error('Failed query: select pg_advisory_xact_lock(...)', { cause })
  }

  it('bounds every lock wait of a tick at 8 s', async () => {
    const m = await landed()
    queries.length = 0
    await m.tick(at(T0, MINUTE))
    const timeout = queries.findIndex((q) => q === "set local lock_timeout = '8s'")
    const lock = queries.findIndex((q) => /pg_advisory_xact_lock/.test(q))
    expect(timeout).toBeGreaterThanOrEqual(0)
    expect(lock).toBeGreaterThan(timeout)
  })

  it('skips a tick that does not wait while the lock is held, applying nothing', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const busy = contended(() => ({ rows: [{ locked: false }] }))
    const now = at(T0, 6 * MINUTE)
    const tick = await tickMission(busy, {
      store: m.store,
      jev: m.jev.client,
      missionId: m.missionId,
      now,
      lock: 'try',
    })
    expect(tick).toEqual({
      settled: null,
      closed: null,
      started: null,
      opened: null,
      skipped: 'busy',
    })
    expect(await getRound(db, m.round.id)).toMatchObject({ status: 'open' })
    expect((await m.tick(now)).closed).not.toBeNull()
  })

  it('skips a tick that does not wait when a lock wait times out', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const slow = contended(() => Promise.reject(lockTimeout()))
    const tick = await tickMission(slow, {
      store: m.store,
      jev: m.jev.client,
      missionId: m.missionId,
      now: at(T0, 6 * MINUTE),
      lock: 'try',
    })
    expect(tick.skipped).toBe('busy')
  })

  it('fails a waiting tick past the lock timeout as BUSY, answered 503 with retry-after', async () => {
    const m = await landed()
    const slow = contended(() => Promise.reject(lockTimeout()))
    const failure = await tickMission(slow, {
      store: m.store,
      jev: m.jev.client,
      missionId: m.missionId,
      now: at(T0, MINUTE),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DbError)
    expect((failure as DbError).code).toBe('BUSY')
    const answer = httpErrorOf(failure)
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({ code: 'BUSY' })
    expect(answer.headers?.get('retry-after')).toBe('5')
  })
})
