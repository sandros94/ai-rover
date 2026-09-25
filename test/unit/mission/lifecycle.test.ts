import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { like } from '#server/repositories/likes'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { getSegment } from '#server/repositories/segments'
import { getStop, listStops } from '#server/repositories/stops'
import { listRoundSubmissions } from '#server/repositories/submissions'
import { createMissionAtStop } from '#server/utils/mission/create'
import { publicMissionState } from '#server/utils/mission/state'
import { submitGoal } from '#server/utils/mission/submit'
import { tickMission } from '#server/utils/mission/tick'
import {
  DEFAULT_SLICE_SECONDS,
  parseStoredSegmentManifest,
  segmentManifestKey,
  segmentSliceKey,
} from '#shared/utils/drive'
import { parseStopManifest } from '#shared/utils/terrain'
import { at, createTestDb, fakeJev, memoryStore, MINUTE, T0, tableCounts, users } from './helpers'

vi.setConfig({ testTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

async function landed(judge?: Parameters<typeof fakeJev>[0]) {
  const { store, blobs } = memoryStore()
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    now: T0,
  })
  const missionId = created.mission.id
  const jev = fakeJev(judge)
  const [ada, bob, cy] = await users(db, 'Ada', 'Bob', 'Cy')
  return {
    ...created,
    missionId,
    store,
    blobs,
    ada: ada!,
    bob: bob!,
    cy: cy!,
    submit: (userId: string, goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId, userId, goal, now }),
    tick: (now: Date) => tickMission(db, { store, missionId, now }),
  }
}

describe('an idle rover and the grace window', () => {
  it('closes the round five minutes after the first submission, then starts the drive', async () => {
    const m = await landed()
    const submittedAt = at(T0, 60 * MINUTE)
    const { submission } = await m.submit(m.ada.id, { x: 0, y: 80 }, submittedAt)

    const early = await m.tick(at(submittedAt, 5 * MINUTE - 1))
    expect(early).toEqual({ settled: null, closed: null, started: null, opened: null })
    expect((await getOpenRound(db, m.missionId))?.id).toBe(m.round.id)

    const closesAt = at(submittedAt, 5 * MINUTE)
    const now = at(closesAt, 2 * MINUTE)
    const tick = await m.tick(now)
    expect(tick.closed).toEqual({ roundId: m.round.id, winnerSubmissionId: submission!.id })
    expect(tick.settled).toBeNull()
    expect(tick.started).not.toBeNull()
    expect(tick.opened).not.toBeNull()

    const [closed] = await listRoundSubmissions(db, m.round.id)
    expect(closed?.status).toBe('won')

    const segment = await getSegment(db, tick.started!.segmentId)
    expect(segment).toMatchObject({
      missionId: m.missionId,
      roundId: m.round.id,
      submissionId: submission!.id,
      fromStopId: m.stop.id,
      status: 'driving',
      startedAt: now,
      attempt: 1,
      toStopId: null,
    })
    expect(segment.outcome?.kind).toMatch(/arrived|stopped-short|failed/)

    // Every slice is in the store, and the segment ends when the last one is released.
    const manifest = parseStoredSegmentManifest(
      await m.store.getJson(segmentManifestKey(segment.id)),
    )
    expect(manifest).toMatchObject({ segmentId: segment.id, startedAt: now.getTime() })
    const slices = (await m.store.listKeys(`segments/${segment.id}/slices/`)).length
    expect(slices).toBeGreaterThan(0)
    expect(await m.store.has(segmentSliceKey(segment.id, slices - 1))).toBe(true)
    expect(segment.endsAt.getTime()).toBe(now.getTime() + slices * DEFAULT_SLICE_SECONDS * 1000)

    // The next round opens from the stop the rover will be at; the mission still sits at stop 0.
    const next = (await getOpenRound(db, m.missionId))!
    expect(next.id).toBe(tick.opened!.roundId)
    expect(next.opensAt).toEqual(now)
    expect((await getMission(db, m.missionId)).currentStopId).toBe(m.stop.id)
    const destination = await getStop(db, next.fromStopId)
    expect(destination).toMatchObject({ index: 1, fromSegmentId: segment.id })
    expect(destination.x).toBeCloseTo(segment.outcome!.endPose.x, 9)
    expect(destination.y).toBeCloseTo(segment.outcome!.endPose.y, 9)
    const stopManifest = parseStopManifest(await m.store.getJson(destination.manifestKey))
    expect(stopManifest.stop.index).toBe(1)
    expect(await m.store.has(destination.revealedKey)).toBe(true)
  })

  it('shows the drive without its outcome or end until it is released', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const now = at(T0, 10 * MINUTE)
    const tick = await m.tick(now)
    const state = await publicMissionState(db, { missionId: m.missionId, now })
    expect(state.now).toEqual(now)
    expect(state.currentStop.id).toBe(m.stop.id)
    expect(state.segment).toMatchObject({
      id: tick.started!.segmentId,
      status: 'driving',
      startedAt: now,
      attempt: 1,
    })
    expect(state.release).toEqual({ startedAt: now, sliceSeconds: DEFAULT_SLICE_SECONDS })
    const text = JSON.stringify(state)
    expect(state.segment).not.toHaveProperty('outcome')
    expect(state.segment).not.toHaveProperty('endsAt')
    expect(state.round).not.toHaveProperty('fromStopId')
    // Nothing names the stop the rover is driving to.
    const next = (await getOpenRound(db, m.missionId))!
    expect(text).not.toContain(next.fromStopId)
    expect(state.round).toMatchObject({ id: next.id, closesAt: null, submissions: [] })
  })
})

describe('settlement', () => {
  it('settles the drive from its stored outcome once its end passes, and moves the mission', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const started = (await m.tick(at(T0, 6 * MINUTE))).started!
    const driving = await getSegment(db, started.segmentId)
    const destination = (await getOpenRound(db, m.missionId))!.fromStopId

    const before = await m.tick(at(driving.endsAt, -1))
    expect(before.settled).toBeNull()
    expect((await getSegment(db, driving.id)).status).toBe('driving')

    const settled = await m.tick(driving.endsAt)
    expect(settled.settled).toEqual({ segmentId: driving.id, status: driving.outcome!.kind })
    expect(settled.closed).toBeNull()
    const row = await getSegment(db, driving.id)
    expect(row).toMatchObject({ status: 'arrived', toStopId: destination, deathX: null })
    expect((await getMission(db, m.missionId)).currentStopId).toBe(destination)
    // Nobody submitted during the drive: the rover idles at its new stop.
    const state = await publicMissionState(db, { missionId: m.missionId, now: driving.endsAt })
    expect(state.currentStop.id).toBe(destination)
    expect(state.segment).toBeNull()
    expect(state.round!.closesAt).toBeNull()
  })

  it('closes the next round when the drive ends if a submission was waiting', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const first = (await m.tick(at(T0, 6 * MINUTE))).started!
    const driving = await getSegment(db, first.segmentId)
    const stop1 = await getStop(db, (await getOpenRound(db, m.missionId))!.fromStopId)
    const goal = { x: stop1.x + 80, y: stop1.y }
    const { submission } = await m.submit(m.bob.id, goal, at(T0, 10 * MINUTE))

    // It closes with the drive, whose end stays private while it plays.
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, 10 * MINUTE) })
    expect(state.round!.closesAt).toBeNull()
    expect(state.round!.submissions.map((s) => s.id)).toEqual([submission!.id])

    const tick = await m.tick(driving.endsAt)
    expect(tick.settled?.segmentId).toBe(driving.id)
    expect(tick.closed?.winnerSubmissionId).toBe(submission!.id)
    const second = await getSegment(db, tick.started!.segmentId)
    expect(second).toMatchObject({ fromStopId: stop1.id, startedAt: driving.endsAt, attempt: 1 })
    expect((await getStop(db, (await getOpenRound(db, m.missionId))!.fromStopId)).index).toBe(2)
  })

  it('changes nothing when ticked twice at the same instant', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const now = at(T0, 6 * MINUTE)
    await m.tick(now)
    const counts = await tableCounts(db)
    const writes = m.blobs.writes.length
    expect(await m.tick(now)).toEqual({ settled: null, closed: null, started: null, opened: null })
    expect(await tableCounts(db)).toEqual(counts)
    expect(m.blobs.writes).toHaveLength(writes)
  })
})

describe('likes and ranking', () => {
  it('lets likes decide the winner', async () => {
    const m = await landed()
    const a = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const b = await m.submit(m.bob.id, { x: 80, y: 0 }, at(T0, 2 * MINUTE))
    await like(db, b.submission!.id, { userId: m.cy.id })
    await like(db, b.submission!.id, { userId: m.bob.id })
    await like(db, a.submission!.id, { userId: m.ada.id })
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, 3 * MINUTE) })
    expect(state.round!.submissions.map((s) => [s.id, s.likes])).toEqual([
      [a.submission!.id, 1],
      [b.submission!.id, 2],
    ])
    expect(state.round!.closesAt).toEqual(at(T0, 6 * MINUTE))
    const tick = await m.tick(at(T0, 6 * MINUTE))
    expect(tick.closed?.winnerSubmissionId).toBe(b.submission!.id)
    const statuses = (await listRoundSubmissions(db, m.round.id)).map((s) => s.status)
    expect(statuses).toEqual(['lost', 'won'])
  })

  it('breaks a tie by the lower risk first', async () => {
    // The route north is judged riskier than the route east.
    const m = await landed((summary) => ({
      risk: {
        score: summary.destination.bearing === 'north' ? 2 : 0.5,
        confidence: 0.7,
        probabilities: [0.2, 0.7, 0.1, 0],
      },
    }))
    await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const east = await m.submit(m.bob.id, { x: 80, y: 0 }, at(T0, 2 * MINUTE))
    const tick = await m.tick(at(T0, 6 * MINUTE))
    expect(tick.closed?.winnerSubmissionId).toBe(east.submission!.id)
  })
})

describe('the public state', () => {
  it('lists open submissions with like counts, public judgment fields and the summary', async () => {
    const m = await landed()
    const a = await m.submit(m.ada.id, { x: 0, y: 80 }, at(T0, MINUTE))
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, MINUTE) })
    expect(state.mission).toMatchObject({ id: m.missionId, status: 'active' })
    expect(state.mission).not.toHaveProperty('seed')
    expect(state.round!.submissions).toEqual([
      {
        id: a.submission!.id,
        goal: { x: 0, y: 80 },
        createdAt: at(T0, MINUTE),
        likes: 0,
        submitter: { id: m.ada.id, displayName: 'Ada', avatarUrl: null },
        judgment: {
          feasible: 0.9,
          verdict: 'accept',
          risk: 1,
          distanceWeight: 1,
          timeWeight: 2 / 3,
        },
        summary: a.submission!.summary,
      },
    ])
    expect(await listStops(db, m.missionId)).toHaveLength(1)
  })
})
