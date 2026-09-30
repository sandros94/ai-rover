import { H3 } from 'nitro/h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { mission as missionTable } from '#server/database/schema'
import { getActiveMission, getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { JUDGE_UNAVAILABLE, JudgeError } from '#server/utils/jev/errors'
import { createMissionAtStop } from '#server/utils/mission/create'
import { LifecycleError } from '#server/utils/mission/errors'
import {
  defineMissionHandlerWith,
  httpErrorOf,
  missionCacheHeaders,
  syncMission,
} from '#server/utils/mission/http'
import { submitGoal } from '#server/utils/mission/submit'
import { tickMission } from '#server/utils/mission/tick'
import {
  at,
  createTestDb,
  endMissions,
  fakeJev,
  memoryStore,
  MINUTE,
  SMALL_RULES,
  T0,
  users,
} from './helpers'

vi.mock('#server/utils/mission/tick', async (original) => {
  const actual = await original<typeof import('#server/utils/mission/tick')>()
  return { ...actual, tickMission: vi.fn<typeof actual.tickMission>(actual.tickMission) }
})
vi.setConfig({ testTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())
afterEach(() => {
  vi.mocked(tickMission).mockClear()
  vi.restoreAllMocks()
})

async function landed() {
  const { store } = memoryStore()
  await endMissions(db)
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    rules: SMALL_RULES,
    now: T0,
  })
  const jev = fakeJev()
  const dispatch = vi.fn<(missionId: string) => void>()
  const sync = async (access: 'read' | 'write', now: Date) =>
    syncMission(db, {
      mission: await getMission(db, created.mission.id),
      access,
      store,
      jev: jev.client,
      now,
      dispatch,
    })
  return { ...created, store, jev, dispatch, sync }
}

describe('syncMission', () => {
  it('reads without ticking, and so without the lock, while nothing is due', async () => {
    const m = await landed()
    expect((await getMission(db, m.mission.id)).nextDueAt).toBeNull()
    expect(await m.sync('read', at(T0, MINUTE))).toBeNull()
    expect(tickMission).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()

    const [ada] = await users(db, 'Ada')
    await submitGoal(db, {
      store: m.store,
      jev: m.jev.client,
      missionId: m.mission.id,
      userId: ada!.id,
      goal: { x: 0, y: 20 },
      now: at(T0, MINUTE),
    })
    // Due five minutes after the first submission; a read just before still does not tick.
    expect(await m.sync('read', at(T0, 6 * MINUTE - 1))).toBeNull()
    expect(tickMission).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
  })

  it('answers a due read at once and dispatches its tick to the background function', async () => {
    const m = await landed()
    const [ada] = await users(db, 'Ada')
    await submitGoal(db, {
      store: m.store,
      jev: m.jev.client,
      missionId: m.mission.id,
      userId: ada!.id,
      goal: { x: 0, y: 20 },
      now: at(T0, MINUTE),
    })
    expect(await m.sync('read', at(T0, 6 * MINUTE))).toBeNull()
    expect(m.dispatch).toHaveBeenCalledExactlyOnceWith(m.mission.id)
    expect(tickMission).not.toHaveBeenCalled()
    expect(await getOpenRound(db, m.mission.id)).toMatchObject({ id: m.round.id })
  })

  it('always ticks a write, and never dispatches', async () => {
    const m = await landed()
    const tick = await m.sync('write', at(T0, MINUTE))
    expect(tickMission).toHaveBeenCalledTimes(1)
    expect(tick).toEqual({ settled: null, closed: null, started: null, opened: null })
    expect(m.dispatch).not.toHaveBeenCalled()
  })

  it("dispatches a due read's tick to the request's own origin", async () => {
    const m = await landed()
    // The route acts at the wall clock, so the mission is made due long before it.
    await db.update(missionTable).set({ nextDueAt: new Date(0) })
    const active = await getActiveMission(db)
    const dispatch = vi.fn<(missionId: string, origin: string) => void>()
    const platform = {
      db: () => db,
      sessions: () => {
        throw new Error('A route without `user` reads no session.')
      },
      store: () => m.store,
      dispatch,
    }
    const app = new H3().get(
      '/api/read',
      defineMissionHandlerWith(platform, { access: 'read', cache: 'public' }, async () => 'ok'),
    )
    const answer = await app.request('https://deploy-preview-7--rover.netlify.app/api/read')
    expect(answer.status).toBe(200)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      active!.id,
      'https://deploy-preview-7--rover.netlify.app',
    )
  })
})

describe('missionCacheHeaders', () => {
  it('lets browsers and the CDN share the public state briefly, tagged by mission', () => {
    expect(missionCacheHeaders('m1', 'public')).toEqual({
      'cache-control': 'public, max-age=5, stale-while-revalidate=30',
      'netlify-cdn-cache-control': 'public, max-age=5, stale-while-revalidate=30, durable',
      'netlify-cache-tag': 'mission-m1',
    })
  })

  it('keeps a slower public answer for as long as it is told, still tagged by mission', () => {
    expect(missionCacheHeaders('m1', 'public', { maxAgeS: 60 })).toEqual({
      'cache-control': 'public, max-age=60, stale-while-revalidate=30',
      'netlify-cdn-cache-control': 'public, max-age=60, stale-while-revalidate=30, durable',
      'netlify-cache-tag': 'mission-m1',
    })
  })

  it('stores nothing anywhere for everything else', () => {
    expect(missionCacheHeaders('m1', 'none')).toEqual({
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': 'no-store',
    })
  })
})

describe('httpErrorOf', () => {
  it('answers an upstream Jev failure with the fixed message and logs its cause', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('502 Bad Gateway from api.example: secret-ish detail')
    const error = httpErrorOf(new JudgeError('UPSTREAM', JUDGE_UNAVAILABLE, { cause }))
    expect(error.status).toBe(502)
    expect(error.message).toBe(JUDGE_UNAVAILABLE)
    expect(JSON.stringify(error.toJSON())).not.toContain('secret-ish')
    expect(logged).toHaveBeenCalledWith(expect.anything(), cause)
  })

  it('answers a paused mission with 423 and the operator message', () => {
    const error = httpErrorOf(new LifecycleError('MISSION_PAUSED', 'Dust storm.'))
    expect(error.status).toBe(423)
    expect(error.message).toBe('Dust storm.')
    expect(error.body).toEqual({ code: 'MISSION_PAUSED' })
  })
})
