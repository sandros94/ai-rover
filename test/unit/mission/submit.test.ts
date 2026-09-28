import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { countLikes } from '#server/repositories/likes'
import { pauseMission, resumeMission } from '#server/repositories/pauses'
import { reanchorRound } from '#server/repositories/rounds'
import { listRoundSubmissions, withdrawSubmission } from '#server/repositories/submissions'
import { createMissionAtStop } from '#server/utils/mission/create'
import { LifecycleError } from '#server/utils/mission/errors'
import { submitGoal } from '#server/utils/mission/submit'
import { DEFAULT_MISSION_RULES, explorationValue } from '#shared/utils/mission'
import {
  believedReachable,
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  revealedOverDisk,
} from '#shared/utils/terrain'
import {
  at,
  createTestDb,
  dbErrorOf,
  fakeJev,
  memoryStore,
  MINUTE,
  SMALL_RULES,
  T0,
  users,
} from './helpers'

vi.setConfig({ testTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

async function landed(judge?: Parameters<typeof fakeJev>[0]) {
  const { store } = memoryStore()
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    rules: SMALL_RULES,
    now: T0,
  })
  const jev = fakeJev(judge)
  const [ada, bob] = await users(db, 'Ada', 'Bob')
  const submit = (userId: string, goal: { x: number; y: number }, now = at(T0, MINUTE)) =>
    submitGoal(db, { store, jev: jev.client, missionId: created.mission.id, userId, goal, now })
  return { ...created, store, jev, ada: ada!, bob: bob!, submit }
}

describe('submitGoal', () => {
  it('refuses drives planned under 4 min or over 30 min without asking Jev, saying how long', async () => {
    const { ada, submit, jev, round } = await landed()
    expect(await submit(ada.id, { x: 0, y: 5 })).toEqual({
      accepted: false,
      reason: 'too-short',
      submission: null,
      message: expect.stringMatching(
        /^The planned drive takes about \d+ min; a segment drives at least 4 min\.$/,
      ),
    })
    expect(await submit(ada.id, { x: 0, y: 75 })).toEqual({
      accepted: false,
      reason: 'too-long',
      submission: null,
      message: expect.stringMatching(
        /^The planned drive takes about \d+ min; a segment drives at most 30 min\.$/,
      ),
    })
    expect(jev.summaries).toHaveLength(0)
    expect(await listRoundSubmissions(db, round.id)).toEqual([])
  })

  it('refuses a goal beyond the 125 m survey as outside, without asking Jev', async () => {
    const { ada, submit, jev, round } = await landed()
    expect(await submit(ada.id, { x: 0, y: 126 })).toEqual({
      accepted: false,
      reason: 'outside',
      submission: null,
    })
    expect(jev.summaries).toHaveLength(0)
    expect(await listRoundSubmissions(db, round.id)).toEqual([])
  })

  it('stores a valid goal as an open submission with its judgment, metrics and summary', async () => {
    const { ada, submit, jev, round } = await landed()
    const result = await submit(ada.id, { x: 0.4, y: 20.3 })
    expect(result.accepted).toBe(true)
    const { submission } = result
    expect(submission).toMatchObject({
      roundId: round.id,
      userId: ada.id,
      status: 'open',
      goalX: 0,
      goalY: 20,
      createdAt: at(T0, MINUTE),
      judgment: { verdict: 'accept', risk: { score: 1 } },
      metrics: { reached: true },
    })
    expect(submission!.judgment).not.toHaveProperty('cached')
    expect(jev.summaries).toEqual([submission!.summary])
  })

  it('snaps a goal on blocked ground to the nearest pathable vertex before the rules', async () => {
    // A low slope limit leaves blocked ground next to pathable ground near the stop.
    const world = { slopeLimitDeg: 6 }
    const { store } = memoryStore()
    const created = await createMissionAtStop(db, {
      store,
      seed: 'steep',
      at: { x: 0, y: 0 },
      world,
      rules: SMALL_RULES,
      now: T0,
    })
    const steep = defineWorld({ seed: 'steep', ...world })
    const disk = computeStopDisk(steep, { center: { x: 0, y: 0 }, radius: SMALL_RULES.stopRadiusM })
    const { width } = disk.grid
    const revealed = revealedOverDisk(revealDisk(createRevealedMask(steep), disk), disk)
    const { reachable } = believedReachable(disk, revealed)
    const pathable = (x: number, y: number) => {
      const k = (y - disk.origin.j) * width + (x - disk.origin.i)
      return revealed[k] === 1 && disk.traversable[k] === 1 && reachable[k] === 1
    }
    // A seen blocked vertex with a pathable neighbour, and one with nothing pathable within 5 m.
    let edge: { x: number; y: number } | undefined
    let island: { x: number; y: number } | undefined
    for (let y = -45; y <= 45 && !(edge && island); y++) {
      for (let x = -45; x <= 45 && !(edge && island); x++) {
        const distance = Math.hypot(x, y)
        if (distance < 20 || distance > 45 || pathable(x, y)) continue
        if (!revealed[(y - disk.origin.j) * width + (x - disk.origin.i)]) continue
        let near = false
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            if (Math.hypot(dx, dy) <= 5 && pathable(x + dx, y + dy)) near = true
          }
        }
        if (near && pathable(x + 1, y)) edge ??= { x, y }
        if (!near) island ??= { x, y }
      }
    }
    expect(edge && island).toBeDefined()
    const jev = fakeJev()
    const [ada] = await users(db, 'Ada')
    const submit = (goal: { x: number; y: number }) =>
      submitGoal(db, {
        store,
        jev: jev.client,
        missionId: created.mission.id,
        userId: ada!.id,
        goal,
        now: at(T0, MINUTE),
      })

    expect(await submit(island!)).toEqual({
      accepted: false,
      reason: 'unpathable',
      submission: null,
    })
    expect(jev.summaries).toHaveLength(0)
    const snapped = await submit(edge!)
    expect(snapped.submission).not.toBeNull()
    const goal = { x: snapped.submission!.goalX, y: snapped.submission!.goalY }
    expect(goal).not.toEqual(edge)
    expect(pathable(goal.x, goal.y)).toBe(true)
    expect(Math.hypot(goal.x - edge!.x, goal.y - edge!.y)).toBe(1)
  })

  it('takes a goal on ground the rover has not seen at the vertex picked, planned through the fog', async () => {
    const { store } = memoryStore()
    const created = await createMissionAtStop(db, {
      store,
      seed: 'fogged-goal',
      at: { x: 0, y: 0 },
      rules: SMALL_RULES,
      now: T0,
    })
    const jev = fakeJev()
    const [ada] = await users(db, 'Ada')
    const result = await submitGoal(db, {
      store,
      jev: jev.client,
      missionId: created.mission.id,
      userId: ada!.id,
      goal: { x: -30.3, y: 0.2 },
      now: at(T0, MINUTE),
    })
    expect(result.accepted).toBe(true)
    const { submission } = result
    expect({ x: submission!.goalX, y: submission!.goalY }).toEqual({ x: -30, y: 0 })
    expect(submission!.metrics).toMatchObject({ reached: true, goalInFog: true })
    expect(submission!.metrics.unrevealedFraction).toBeGreaterThan(0)
    expect(jev.summaries).toHaveLength(1)
    // The code's parts from the plan and the landing stop's mask; nothing driven yet.
    const parts = submission!.explorationParts
    expect(parts).toEqual({
      pathInFog: submission!.metrics.unrevealedFraction,
      goalInFog: 1,
      pocket: parts.pocket,
    })
    expect(jev.summaries[0]!.exploration).toMatchObject({ destination_unexplored: true })
    expect(jev.summaries[0]!.recent_stops).toEqual([])
    // The mean of the code's value and Jev's, which answers 0.5 here.
    const code = explorationValue(parts, { weights: DEFAULT_MISSION_RULES.explorationWeights })
    expect(submission!.exploration).toBeCloseTo((code + 0.5) / 2, 12)
  })

  it('stores a rejected verdict as a rejected submission and reports it', async () => {
    const { ada, submit, round } = await landed(() => ({ feasible: 0.1, verdict: 'reject' }))
    const result = await submit(ada.id, { x: 0, y: 20 })
    expect(result).toMatchObject({
      accepted: false,
      reason: 'judged-infeasible',
      submission: {
        status: 'rejected',
        rejectionReason: 'judged-infeasible',
        judgment: { verdict: 'reject' },
      },
    })
    // A rejection holds no place in the round: the user may submit again.
    const [listed] = await listRoundSubmissions(db, round.id)
    expect(listed?.status).toBe('rejected')
    expect((await submit(ada.id, { x: 15, y: 0 })).submission?.status).toBe('rejected')
  })

  it('refuses a second open submission by the same user, and accepts one after withdrawal', async () => {
    const { ada, submit, jev } = await landed()
    const first = await submit(ada.id, { x: 0, y: 20 })
    const error = await dbErrorOf(submit(ada.id, { x: 15, y: 0 }))
    expect(error?.code).toBe('ALREADY_SUBMITTED')
    // Refused before planning, so Jev is not paid for it.
    expect(jev.summaries).toHaveLength(1)
    await withdrawSubmission(db, first.submission!.id, { userId: ada.id })
    const again = await submit(ada.id, { x: 15, y: 0 })
    expect(again).toMatchObject({ accepted: true, submission: { status: 'open', goalX: 15 } })
  })

  it('refuses a sixth attempt in a round before planning, counting withdrawals and rejections', async () => {
    let verdict: 'accept' | 'reject' = 'accept'
    const { ada, bob, submit, jev, round, mission } = await landed(() =>
      verdict === 'reject' ? { feasible: 0.1, verdict } : {},
    )
    expect(mission.config.rules.maxJudgedPerRound).toBe(5)
    // Three withdrawn, one rejected by Jev, one still open: five attempts.
    for (let k = 0; k < 3; k++) {
      const { submission } = await submit(ada.id, { x: 0, y: 20 + k })
      await withdrawSubmission(db, submission!.id, { userId: ada.id })
    }
    // A refusal by rule stores nothing and pays no Jev, so it is not an attempt.
    expect(await submit(ada.id, { x: 0, y: 5 })).toMatchObject({ reason: 'too-short' })
    verdict = 'reject'
    expect(await submit(ada.id, { x: 0, y: 23 })).toMatchObject({ reason: 'judged-infeasible' })
    verdict = 'accept'
    const open = await submit(ada.id, { x: 0, y: 24 })
    await withdrawSubmission(db, open.submission!.id, { userId: ada.id })
    const asked = jev.summaries.length

    expect(await submit(ada.id, { x: 0, y: 25 })).toEqual({
      accepted: false,
      reason: 'too-many-attempts',
      submission: null,
    })
    // Refused before planning, so Jev is not paid for it.
    expect(jev.summaries).toHaveLength(asked)
    expect(await listRoundSubmissions(db, round.id)).toHaveLength(5)
    // The cap is per user.
    expect((await submit(bob.id, { x: 0, y: 20 })).accepted).toBe(true)
  })

  it('refuses as round-changed a goal whose round moved while Jev judged it', async () => {
    let move: (() => Promise<unknown>) | undefined
    const m = await landed(async () => {
      await move?.()
      return {}
    })
    // The round is re-anchored mid-judgment, as a settlement after a stop short would do.
    move = () => reanchorRound(db, m.round.id, { fromStopId: m.stop.id, anchor: { x: 0, y: 2.5 } })
    expect(await m.submit(m.ada.id, { x: 0, y: 20 })).toEqual({
      accepted: false,
      reason: 'round-changed',
      submission: null,
    })
    expect(await listRoundSubmissions(db, m.round.id)).toEqual([])
    // Planned again from the round as it now is, the goal goes through.
    move = undefined
    expect((await m.submit(m.ada.id, { x: 0, y: 20 })).accepted).toBe(true)
  })

  it("starts an accepted goal with its author's LGTM", async () => {
    const { ada, submit } = await landed()
    const result = await submit(ada.id, { x: 0, y: 20 })
    expect(await countLikes(db, result.submission!.id)).toBe(1)
  })

  it('refuses every goal while the mission is paused, with the pause message', async () => {
    const { ada, submit, mission, jev } = await landed()
    await pauseMission(db, mission.id, { message: 'Dust storm.', pausedBy: ada.id, at: T0 })
    const refused = await submit(ada.id, { x: 0, y: 20 }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(LifecycleError)
    expect(refused).toMatchObject({ code: 'MISSION_PAUSED', message: 'Dust storm.' })
    expect(jev.summaries).toHaveLength(0)
    await resumeMission(db, mission.id, { at: at(T0, MINUTE) })
    expect((await submit(ada.id, { x: 0, y: 20 })).accepted).toBe(true)
  })
})
