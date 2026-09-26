import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DriveOutcome } from '#shared/utils/drive'
import type { DB } from '#server/database/db'
import { closeRound, openRound } from '#server/repositories/rounds'
import {
  countRecentFailuresNear,
  createSegment,
  getPublicSegment,
  listDeaths,
  listMissionSegments,
  settleSegment,
} from '#server/repositories/segments'
import { createStop } from '#server/repositories/stops'
import { createSubmission } from '#server/repositories/submissions'
import { createTestDb, dbErrorOf, seedMission, submissionInput } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const T0 = new Date('2026-09-25T12:00:00Z')
const plus = (ms: number) => new Date(T0.getTime() + ms)
const HOUR = 3_600_000

function failedAt(x: number, y: number): DriveOutcome {
  return {
    kind: 'failed',
    reasons: ['stuck'],
    distanceM: 40,
    durationS: 1200,
    endPose: { x, y, headingRad: 0 },
  }
}

/** Runs one winning round from `stopId` into a segment ending one hour after `startedAt`. */
async function driveOnce(
  seeded: Awaited<ReturnType<typeof seedMission>>,
  options: { startedAt: Date; outcome: DriveOutcome; reuseRound?: boolean },
) {
  const round = options.reuseRound
    ? seeded.round
    : await openRound(db, {
        missionId: seeded.mission.id,
        fromStopId: seeded.stop.id,
        anchor: { x: 0, y: 0 },
      })
  const submission = await createSubmission(db, submissionInput(round, seeded.user.id))
  await closeRound(db, round.id, { winnerSubmissionId: submission.id, closesAt: options.startedAt })
  return createSegment(db, {
    missionId: seeded.mission.id,
    roundId: round.id,
    submissionId: submission.id,
    fromStopId: seeded.stop.id,
    startedAt: options.startedAt,
    endsAt: new Date(options.startedAt.getTime() + HOUR),
    manifestKey: 'segments/x/manifest.json',
    outcome: options.outcome,
  })
}

describe('segments', () => {
  it('creates a driving segment, first attempt', async () => {
    const seeded = await seedMission(db)
    const segment = await driveOnce(seeded, {
      startedAt: T0,
      outcome: failedAt(20, 30),
      reuseRound: true,
    })
    expect(segment).toMatchObject({
      status: 'driving',
      attempt: 1,
      toStopId: null,
      deathX: null,
      deathY: null,
      outcome: failedAt(20, 30),
    })
  })

  it('hides the outcome and the end time until the last slice is released', async () => {
    const seeded = await seedMission(db)
    const segment = await driveOnce(seeded, {
      startedAt: T0,
      outcome: failedAt(20, 30),
      reuseRound: true,
    })

    const before = await getPublicSegment(db, segment.id, { now: plus(HOUR - 1) })
    expect(before.released).toBe(false)
    expect(before).not.toHaveProperty('outcome')
    expect(before).not.toHaveProperty('endsAt')
    expect(before.status).toBe('driving')

    const after = await getPublicSegment(db, segment.id, { now: plus(HOUR) })
    expect(after).toMatchObject({ released: true, endsAt: plus(HOUR), outcome: failedAt(20, 30) })

    const listed = await listMissionSegments(db, seeded.mission.id, { now: plus(HOUR - 1) })
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('outcome')
    expect((await dbErrorOf(getPublicSegment(db, seeded.stop.id, { now: T0 })))?.code).toBe(
      'NOT_FOUND',
    )
  })

  it('settles only after release and only once, consistently with the status', async () => {
    const seeded = await seedMission(db)
    const segment = await driveOnce(seeded, {
      startedAt: T0,
      outcome: failedAt(20, 30),
      reuseRound: true,
    })
    const early = await dbErrorOf(
      settleSegment(db, segment.id, {
        now: plus(HOUR - 1),
        status: 'failed',
        death: { x: 20, y: 30 },
      }),
    )
    expect(early?.code).toBe('INVALID_STATE')

    const settled = await settleSegment(db, segment.id, {
      now: plus(HOUR),
      status: 'failed',
      death: { x: 20, y: 30 },
    })
    expect(settled).toMatchObject({ status: 'failed', deathX: 20, deathY: 30, toStopId: null })

    const twice = await dbErrorOf(
      settleSegment(db, segment.id, { now: plus(HOUR), status: 'failed', death: { x: 1, y: 1 } }),
    )
    expect(twice?.code).toBe('INVALID_STATE')
  })

  it('settles an arrival onto a stop of the mission', async () => {
    const seeded = await seedMission(db)
    const segment = await driveOnce(seeded, {
      startedAt: T0,
      outcome: { ...failedAt(0, 80), kind: 'arrived', reasons: [] },
      reuseRound: true,
    })
    const reached = await createStop(db, {
      missionId: seeded.mission.id,
      index: 1,
      x: 0,
      y: 80,
      headingRad: 0,
      manifestKey: 'terrain/0123456789abcdef/stops/1.json',
      revealedKey: 'terrain/0123456789abcdef/revealed/1.bin',
      fromSegmentId: segment.id,
    })
    const settled = await settleSegment(db, segment.id, {
      now: plus(HOUR),
      status: 'arrived',
      toStopId: reached.id,
    })
    expect(settled).toMatchObject({ status: 'arrived', toStopId: reached.id, deathX: null })
  })

  it('counts attempts from the same stop and lists settled deaths only', async () => {
    const seeded = await seedMission(db)
    const first = await driveOnce(seeded, {
      startedAt: T0,
      outcome: failedAt(20, 30),
      reuseRound: true,
    })
    await settleSegment(db, first.id, {
      now: plus(HOUR),
      status: 'failed',
      death: { x: 20, y: 30 },
    })
    const second = await driveOnce(seeded, { startedAt: plus(2 * HOUR), outcome: failedAt(25, 30) })
    expect(second.attempt).toBe(2)

    // The second death is not settled yet, so it is not public.
    expect(await listDeaths(db, seeded.mission.id)).toEqual([
      { segmentId: first.id, fromStopId: seeded.stop.id, x: 20, y: 30, at: plus(HOUR) },
    ])
    await settleSegment(db, second.id, {
      now: plus(3 * HOUR),
      status: 'failed',
      death: { x: 25, y: 30 },
    })
    expect(
      (await listDeaths(db, seeded.mission.id, { fromStopId: seeded.stop.id })).map((d) => d.x),
    ).toEqual([20, 25])
    const third = await driveOnce(seeded, { startedAt: plus(4 * HOUR), outcome: failedAt(0, 0) })
    expect(third.attempt).toBe(3)
  })

  it('counts recent failures near a point', async () => {
    const seeded = await seedMission(db)
    const deaths = [
      { x: 0, y: 0 },
      { x: 30, y: 40 },
      { x: 300, y: 0 },
    ]
    let round = true
    for (const [k, death] of deaths.entries()) {
      const startedAt = plus(k * 2 * HOUR)
      const segment = await driveOnce(seeded, {
        startedAt,
        outcome: failedAt(death.x, death.y),
        reuseRound: round,
      })
      round = false
      await settleSegment(db, segment.id, {
        now: new Date(startedAt.getTime() + HOUR),
        status: 'failed',
        death,
      })
    }
    const near = (radiusM: number, since?: Date) =>
      countRecentFailuresNear(db, seeded.mission.id, { point: { x: 0, y: 0 }, radiusM, since })
    expect(await near(50)).toBe(2)
    expect(await near(49.9)).toBe(1)
    expect(await near(1000)).toBe(3)
    // Deaths count from the time their segment ended.
    expect(await near(50, plus(3 * HOUR))).toBe(1)
    expect(await near(50, plus(3 * HOUR + 1))).toBe(0)
  })
})
