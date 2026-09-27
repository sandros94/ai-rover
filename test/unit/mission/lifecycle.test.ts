import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { like } from '#server/repositories/likes'
import { getMission } from '#server/repositories/missions'
import { pauseMission } from '#server/repositories/pauses'
import { getOpenRound, getRound } from '#server/repositories/rounds'
import { getSegment } from '#server/repositories/segments'
import { getStop, listStops } from '#server/repositories/stops'
import { getSubmission, listRoundSubmissions } from '#server/repositories/submissions'
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
import { parseStopManifest, revealedKey, stopManifestKey } from '#shared/utils/terrain'
import { forced, stopShortAt } from './forced'
import {
  at,
  createTestDb,
  fakeJev,
  memoryStore,
  MINUTE,
  SMALL_RULES,
  T0,
  tableCounts,
  users,
} from './helpers'

vi.mock('#shared/utils/drive/segment', async (original) =>
  (await import('./forced')).forcedDriveSegment(original),
)

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
    rules: SMALL_RULES,
    now: T0,
  })
  const missionId = created.mission.id
  const jev = fakeJev(judge)
  const [ada, bob, cy, dee] = await users(db, 'Ada', 'Bob', 'Cy', 'Dee')
  return {
    ...created,
    missionId,
    store,
    blobs,
    jev,
    ada: ada!,
    bob: bob!,
    cy: cy!,
    dee: dee!,
    submit: (userId: string, goal: { x: number; y: number }, now: Date) =>
      submitGoal(db, { store, jev: jev.client, missionId, userId, goal, now }),
    tick: (now: Date) => tickMission(db, { store, jev: jev.client, missionId, now }),
    /** Whether stop `index`'s manifest or revealed mask is anywhere in the store. */
    published: async (index: number) =>
      (await store.has(stopManifestKey(missionId, index))) ||
      (await store.has(revealedKey(missionId, index))),
  }
}

describe('an idle rover and the grace window', () => {
  it('closes the round five minutes after the first submission, then starts the drive', async () => {
    const m = await landed()
    const submittedAt = at(T0, 60 * MINUTE)
    const { submission } = await m.submit(m.ada.id, { x: 0, y: 20 }, submittedAt)

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

    // The next round opens from the stop the rover leaves, anchored on the winner's goal; the
    // stop the drive reaches exists nowhere yet, neither as a row nor as a blob.
    const next = (await getOpenRound(db, m.missionId))!
    expect(next).toMatchObject({
      id: tick.opened!.roundId,
      opensAt: now,
      fromStopId: m.stop.id,
      anchorX: 0,
      anchorY: 20,
    })
    expect((await getMission(db, m.missionId)).currentStopId).toBe(m.stop.id)
    expect(await listStops(db, m.missionId)).toHaveLength(1)
    expect(await m.published(1)).toBe(false)
  })

  it('shows the drive and the anchor, without the outcome or the end, until it is released', async () => {
    const m = await landed()
    const winner = await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const now = at(T0, 10 * MINUTE)
    const tick = await m.tick(now)
    const state = await publicMissionState(db, { missionId: m.missionId, now })
    expect(state.now).toEqual(now)
    expect(state.currentStop.id).toBe(m.stop.id)
    const route = winner.submission!.summary.route
    if (!route.reached) throw new Error('The fixture goal is reachable.')
    expect(state.segment).toMatchObject({
      id: tick.started!.segmentId,
      status: 'driving',
      startedAt: now,
      attempt: 1,
      // The winner as its round showed it: author, path length and estimated drive time.
      submitter: { displayName: 'Ada', avatarUrl: null },
      plan: { pathLengthM: route.path_length_m, estimatedMinutes: route.estimated_drive_minutes },
    })
    expect(state.release).toEqual({ startedAt: now, sliceSeconds: DEFAULT_SLICE_SECONDS })
    // Unsettled, the drive counts nowhere yet: neither as the last segment nor in the tally.
    expect(state.lastSegment).toBeNull()
    expect(state.tally).toMatchObject({ distanceM: 0, stops: 1, arrived: 0, failed: 0 })
    expect(state.segment).not.toHaveProperty('outcome')
    expect(state.segment).not.toHaveProperty('endsAt')
    const next = (await getOpenRound(db, m.missionId))!
    expect(state.round).toEqual({
      id: next.id,
      opensAt: now,
      closesAt: null,
      fromStopId: m.stop.id,
      anchor: { x: 0, y: 20 },
      submissions: [],
    })
  })

  it('plans a submission made during the drive from the anchor over what was seen before it', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    await m.tick(at(T0, 6 * MINUTE))
    const during = at(T0, 10 * MINUTE)
    // About 25 min of driving from the anchor, over 30 min from the stop the rover left: the
    // time band is measured from the anchor.
    const far = await m.submit(m.bob.id, { x: 0, y: 62.5 }, during)
    expect(far.accepted).toBe(true)
    const beside = await m.submit(m.cy.id, { x: 20, y: 20 }, during)
    expect(beside.submission!.metrics.straightLineM).toBe(20)
    expect(beside.submission!.summary.destination.straight_line_m).toBe(20)
    // Stop 0's mask is what the plan saw; nothing from the drive leaked into it.
    expect(await m.published(1)).toBe(false)
  })
})

describe('settlement', () => {
  it('creates and publishes the stop the drive reached only once the drive ends', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const started = (await m.tick(at(T0, 6 * MINUTE))).started!
    const driving = await getSegment(db, started.segmentId)
    expect(driving.outcome!.kind).toBe('arrived')

    const before = await m.tick(at(driving.endsAt, -1))
    expect(before.settled).toBeNull()
    expect((await getSegment(db, driving.id)).status).toBe('driving')
    expect(await m.published(1)).toBe(false)

    const settled = await m.tick(driving.endsAt)
    expect(settled.settled).toEqual({ segmentId: driving.id, status: 'arrived' })
    expect(settled.closed).toBeNull()
    const [, stop1] = await listStops(db, m.missionId)
    expect(stop1).toMatchObject({
      index: 1,
      fromSegmentId: driving.id,
      headingRad: driving.outcome!.endPose.headingRad,
      manifestKey: stopManifestKey(m.missionId, 1),
      revealedKey: revealedKey(m.missionId, 1),
    })
    expect(stop1!.x).toBeCloseTo(driving.outcome!.endPose.x, 9)
    expect(stop1!.y).toBeCloseTo(driving.outcome!.endPose.y, 9)
    const manifest = parseStopManifest(await m.store.getJson(stop1!.manifestKey))
    expect(manifest).toMatchObject({ missionId: m.missionId, stop: { index: 1 } })
    expect(await m.store.has(stop1!.revealedKey)).toBe(true)
    expect(await getSegment(db, driving.id)).toMatchObject({
      status: 'arrived',
      toStopId: stop1!.id,
      deathX: null,
    })
    expect((await getMission(db, m.missionId)).currentStopId).toBe(stop1!.id)
    // The open round now leaves from the stop reached; arrival keeps its anchor.
    expect(await getOpenRound(db, m.missionId)).toMatchObject({
      fromStopId: stop1!.id,
      anchorX: 0,
      anchorY: 20,
    })
    // Nobody submitted during the drive: the rover idles at its new stop.
    const state = await publicMissionState(db, { missionId: m.missionId, now: driving.endsAt })
    expect(state.currentStop.id).toBe(stop1!.id)
    expect(state.segment).toBeNull()
    expect(state.round!.closesAt).toBeNull()
    expect(state.lastSegment).toEqual({
      id: driving.id,
      status: 'arrived',
      startedAt: driving.startedAt,
      endsAt: driving.endsAt,
      fromStopId: m.stop.id,
      distanceM: driving.outcome!.distanceM,
    })
    expect(state.tally).toMatchObject({
      stops: 2,
      arrived: 1,
      distanceM: driving.outcome!.distanceM,
    })
  })

  it('closes the next round when the drive ends if a submission was waiting', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const first = (await m.tick(at(T0, 6 * MINUTE))).started!
    const driving = await getSegment(db, first.segmentId)
    const goal = { x: 20, y: 20 }
    const { submission } = await m.submit(m.bob.id, goal, at(T0, 10 * MINUTE))

    // It closes with the drive, whose end stays private while it plays.
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, 10 * MINUTE) })
    expect(state.round!.closesAt).toBeNull()
    expect(state.round!.submissions.map((s) => s.id)).toEqual([submission!.id])

    const tick = await m.tick(driving.endsAt)
    expect(tick.settled?.segmentId).toBe(driving.id)
    expect(tick.closed?.winnerSubmissionId).toBe(submission!.id)
    const stop1 = await getStop(db, (await getMission(db, m.missionId)).currentStopId!)
    expect(stop1.index).toBe(1)
    const second = await getSegment(db, tick.started!.segmentId)
    expect(second).toMatchObject({ fromStopId: stop1.id, startedAt: driving.endsAt, attempt: 1 })
    expect(await getOpenRound(db, m.missionId)).toMatchObject({
      fromStopId: stop1.id,
      anchorX: goal.x,
      anchorY: goal.y,
    })
    expect(await m.published(2)).toBe(false)
  })

  it('re-plans and re-judges the waiting submissions from where a drive stopped short', async () => {
    const m = await landed()
    forced.outcomes.push(stopShortAt({ x: 0, y: 10 }))
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const driving = await getSegment(db, (await m.tick(at(T0, 6 * MINUTE))).started!.segmentId)
    const beside = (await getOpenRound(db, m.missionId))!
    const during = at(T0, 10 * MINUTE)
    // From the anchor (0, 20) all three plan within the time band; from (0, 10) Bob's takes over
    // 30 min and Dee's under 4 min, and only Cy's still fits.
    const tooFar = await m.submit(m.bob.id, { x: 0, y: 66.25 }, during)
    const valid = await m.submit(m.cy.id, { x: 20, y: 20 }, during)
    const tooNear = await m.submit(m.dee.id, { x: 0, y: 7.5 }, during)
    for (const result of [tooFar, valid, tooNear]) expect(result.accepted).toBe(true)
    expect(valid.submission!.metrics.straightLineM).toBe(20)
    const asked = m.jev.summaries.length

    const tick = await m.tick(driving.endsAt)
    expect(tick.settled).toEqual({ segmentId: driving.id, status: 'stopped-short' })
    const stop1 = await getStop(db, (await getMission(db, m.missionId)).currentStopId!)
    expect(stop1).toMatchObject({ index: 1, x: 0, y: 10, fromSegmentId: driving.id })
    expect(await getRound(db, beside.id)).toMatchObject({
      fromStopId: stop1.id,
      anchorX: 0,
      anchorY: 10,
    })
    for (const refused of [tooFar, tooNear]) {
      expect(await getSubmission(db, refused.submission!.id)).toMatchObject({
        status: 'rejected',
        rejectionReason: 'invalidated-by-stop',
      })
    }
    // Only the survivor was judged again, over the plan from the real stop; it then won.
    expect(m.jev.summaries).toHaveLength(asked + 1)
    const judged = await getSubmission(db, valid.submission!.id)
    expect(judged.metrics.straightLineM).toBeCloseTo(Math.hypot(20, 10), 9)
    expect(judged.summary).toEqual(m.jev.summaries.at(-1))
    expect(judged.summary).not.toEqual(valid.submission!.summary)
    expect(tick.closed).toEqual({ roundId: beside.id, winnerSubmissionId: judged.id })
    expect(judged.status).toBe('won')
    expect(await getSegment(db, tick.started!.segmentId)).toMatchObject({ fromStopId: stop1.id })
  })

  it('changes nothing when ticked twice at the same instant', async () => {
    const m = await landed()
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const now = at(T0, 6 * MINUTE)
    const started = (await m.tick(now)).started!
    const idle = { settled: null, closed: null, started: null, opened: null }
    let counts = await tableCounts(db)
    let writes = m.blobs.writes.length
    expect(await m.tick(now)).toEqual(idle)
    expect(await tableCounts(db)).toEqual(counts)
    expect(m.blobs.writes).toHaveLength(writes)

    const { endsAt } = await getSegment(db, started.segmentId)
    await m.tick(endsAt)
    counts = await tableCounts(db)
    writes = m.blobs.writes.length
    expect(await m.tick(endsAt)).toEqual(idle)
    expect(await tableCounts(db)).toEqual(counts)
    expect(m.blobs.writes).toHaveLength(writes)
  })
})

describe('likes and ranking', () => {
  it('lets likes decide the winner', async () => {
    const m = await landed()
    const a = await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const b = await m.submit(m.bob.id, { x: 15, y: 0 }, at(T0, 2 * MINUTE))
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
    await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const east = await m.submit(m.bob.id, { x: 15, y: 0 }, at(T0, 2 * MINUTE))
    const tick = await m.tick(at(T0, 6 * MINUTE))
    expect(tick.closed?.winnerSubmissionId).toBe(east.submission!.id)
  })
})

describe('the public state', () => {
  it('lists open submissions with like counts, public judgment fields and the summary', async () => {
    const m = await landed()
    const a = await m.submit(m.ada.id, { x: 0, y: 20 }, at(T0, MINUTE))
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, MINUTE) })
    expect(state.mission).toMatchObject({ id: m.missionId, status: 'active' })
    expect(state.mission).not.toHaveProperty('seed')
    expect(state.round!.submissions).toEqual([
      {
        id: a.submission!.id,
        goal: { x: 0, y: 20 },
        createdAt: at(T0, MINUTE),
        // Submitting is an LGTM on your own entry.
        likes: 1,
        submitter: { id: m.ada.id, displayName: 'Ada', avatarUrl: null },
        deferred: false,
        goalInFog: false,
        judgment: {
          feasible: 0.9,
          verdict: 'accept',
          risk: 1,
          distanceWeight: 1,
          timeWeight: 2 / 3,
          probabilities: {
            risk: [0.2, 0.7, 0.1, 0],
            distanceConfidence: [0, 0.1, 0.2, 0.7],
            timeConfidence: [0.1, 0.2, 0.6, 0.1],
          },
        },
        summary: a.submission!.summary,
      },
    ])
    expect(state.round).toMatchObject({ fromStopId: m.stop.id, anchor: { x: 0, y: 0 } })
    expect(state.tally).toEqual({
      distanceM: 0,
      stops: 1,
      arrived: 0,
      stoppedShort: 0,
      failed: 0,
      resets: 0,
      longestM: 0,
    })
    expect(state.lastSegment).toBeNull()
    expect(state.flags).toBeNull()
    expect(state.pause).toBeNull()
    expect(await listStops(db, m.missionId)).toHaveLength(1)
  })

  it("shows an operator's pause with its message and who paused", async () => {
    const m = await landed()
    await pauseMission(db, m.missionId, { message: 'Dust storm.', pausedBy: m.bob.id, at: T0 })
    const state = await publicMissionState(db, { missionId: m.missionId, now: at(T0, MINUTE) })
    expect(state.pause).toEqual({
      message: 'Dust storm.',
      by: { displayName: 'Bob', avatarUrl: null },
      at: T0,
    })
  })
})
