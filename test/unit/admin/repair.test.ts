import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import type { Stop } from '#server/database/schema'
import { getSegment } from '#server/repositories/segments'
import { listStops, setStopObjects } from '#server/repositories/stops'
import type { AdminContext } from '#server/utils/admin/access'
import { defineAdminRepairStopsHandlerWith, repairStops } from '#server/utils/admin/repair'
import { createMissionAtStop } from '#server/utils/mission/create'
import { submitGoal } from '#server/utils/mission/submit'
import { loadRecordReveals } from '#server/utils/mission/terrain'
import { tickMission } from '#server/utils/mission/tick'
import type { StopRepairEntry, StopRepairReport } from '#shared/utils/admin'
import { reachedMask } from '#shared/utils/mission'
import {
  computeStopDisk,
  decodeRevealedMask,
  defineWorld,
  encodeRevealedMask,
  parseStopManifest,
} from '#shared/utils/terrain'
import {
  at,
  createTestDb,
  fakeJev,
  memoryStore,
  MINUTE,
  SMALL_RULES,
  T0,
  users,
} from '../mission/helpers'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const TOKEN = 'operator-token-for-tests-0123456789'
const ORIGIN = 'https://rover.test'
const BINARY = { contentType: 'application/octet-stream' }

let db: DB
let close: () => Promise<void>
const { store, blobs } = memoryStore()
let missionId: string
/** The stops as settlement recorded them, before any damage. */
let settled: Stop[]

/**
 * A landing and two drives settled as the tick settles them, then the damage a tick working from
 * an old snapshot left on the live mission: stop 1 names the landing's mask and pack under keys
 * named by its index, and stop 2's mask was built on that stale one.
 */
beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  const created = await createMissionAtStop(db, {
    store,
    seed: 'mars',
    at: { x: 0, y: 0 },
    rules: SMALL_RULES,
    now: T0,
  })
  missionId = created.mission.id
  const jev = fakeJev().client
  const [ada, bob] = await users(db, 'Ada', 'Bob')
  const tick = (now: Date) => tickMission(db, { store, jev, missionId, now })
  const submit = (userId: string, goal: { x: number; y: number }, now: Date) =>
    submitGoal(db, { store, jev, missionId, userId, goal, now })

  /** The lifecycle went otherwise than this setup relies on. */
  const must = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`Setup: ${what} did not happen.`)
  }
  must((await submit(ada!.id, { x: 0, y: 20 }, at(T0, MINUTE))).accepted, 'the first goal')
  const first = await getSegment(db, (await tick(at(T0, 6 * MINUTE))).started!.segmentId)
  must((await tick(first.endsAt)).settled?.segmentId === first.id, 'the first settlement')
  const [, reached] = await listStops(db, missionId)
  const goal = { x: reached!.x + 20, y: reached!.y + 5 }
  must((await submit(bob!.id, goal, at(first.endsAt, MINUTE))).accepted, 'the second goal')
  const second = await getSegment(db, (await tick(at(first.endsAt, 6 * MINUTE))).started!.segmentId)
  must((await tick(second.endsAt)).settled?.segmentId === second.id, 'the second settlement')
  settled = await listStops(db, missionId)

  const [landing, stop1, stop2] = settled as [Stop, Stop, Stop]
  const manifestOf = async (stop: Stop) => parseStopManifest(await store.getJson(stop.manifestKey))
  const legacy = (index: number) => ({
    manifestKey: `missions/${missionId}/stops/${index}.json`,
    revealedKey: `missions/${missionId}/revealed/${index}.bin`,
    packKey: `missions/${missionId}/stops/${index}.pack`,
  })
  async function store1(
    stop: Stop,
    keys: ReturnType<typeof legacy>,
    mask: Uint8Array,
    pack: Uint8Array,
  ) {
    const manifest = await manifestOf(stop)
    await store.putImmutable(keys.revealedKey, mask, BINARY)
    await store.putImmutable(keys.packKey, pack, BINARY)
    await store.putJson(keys.manifestKey, {
      ...manifest,
      version: 3,
      stop: { index: stop.index, ...manifest.stop },
      revealedKey: keys.revealedKey,
      packKey: keys.packKey,
    })
    await setStopObjects(db, stop.id, keys)
  }
  const landingMask = (await store.getInflated(landing.revealedKey))!
  const landingPack = (await store.getInflated((await manifestOf(landing)).packKey!))!
  await store1(stop1, legacy(1), landingMask, landingPack)

  const world = defineWorld({ seed: 'mars' })
  const radius = SMALL_RULES.stopRadiusM
  const onStale = reachedMask(
    {
      mask: decodeRevealedMask(landingMask),
      disk: computeStopDisk(world, { center: stop1, radius }),
    },
    {
      reveals: await loadRecordReveals(store, second),
      disk: computeStopDisk(world, { center: stop2, radius }),
    },
  )
  const ownPack = (await store.getInflated((await manifestOf(stop2)).packKey!))!
  await store1(stop2, legacy(2), encodeRevealedMask(onStale), ownPack)
})
afterAll(() => close())

const rows = () => listStops(db, missionId)

/** Every stop through bounded calls, as the admin page walks them. */
async function walk(apply: boolean, budgetMs?: number): Promise<StopRepairEntry[]> {
  const entries: StopRepairEntry[] = []
  let cursor: StopRepairReport['cursor'] | undefined
  do {
    const report = await repairStops(db, { store, apply, cursor: cursor ?? undefined, budgetMs })
    expect(report.total).toBe(3)
    entries.push(...report.stops)
    cursor = report.cursor
  } while (cursor)
  return entries
}

describe('repairing the stops', () => {
  it('reports each stale stop in a dry run, pointing no stop elsewhere', async () => {
    const before = await rows()
    const report = await walk(false)
    expect(report.map((s) => [s.index, s.stale, s.packMatches, s.applied])).toEqual([
      [0, false, true, false],
      [1, true, false, false],
      [2, true, true, false],
    ])
    const [landing, stop1, stop2] = report as [StopRepairEntry, StopRepairEntry, StopRepairEntry]
    expect(landing).toMatchObject({ missing: 0, extra: 0, manifestKey: settled[0]!.manifestKey })
    expect(landing.stored).toBe(landing.recomputed)
    // Stop 1 holds the landing's mask: nothing of its drive nor its own viewshed.
    expect(stop1.missing).toBeGreaterThan(0)
    expect(stop1.extra).toBe(0)
    expect(stop1.stored).toBe(landing.stored)
    // Stop 2 carries the loss on; its pack is its own.
    expect(stop2.missing).toBeGreaterThan(0)
    expect(stop2.extra).toBe(0)
    // Corrected under the keys settlement gave them: the same objects, named by what produced them.
    expect([stop1.manifestKey, stop2.manifestKey]).toEqual([
      settled[1]!.manifestKey,
      settled[2]!.manifestKey,
    ])
    expect(await rows()).toEqual(before)
  })

  it('walks the stops one per call from the cursor, to the same report', async () => {
    const whole = await walk(false)
    expect(await walk(false, 0)).toEqual(whole)
  })

  it('points each stale stop at objects equal to what settlement stored, then finds none stale', async () => {
    const applied = await walk(true, 0)
    expect(applied.map((s) => [s.index, s.stale, s.applied])).toEqual([
      [0, false, false],
      [1, true, true],
      [2, true, true],
    ])
    const now = await rows()
    for (const [k, stop] of now.entries()) {
      expect(stop.manifestKey).toBe(settled[k]!.manifestKey)
      expect(stop.revealedKey).toBe(settled[k]!.revealedKey)
    }
    // The objects the old keys name stay stored for whoever still holds them.
    expect(await store.has(`missions/${missionId}/revealed/1.bin`)).toBe(true)

    const writes = blobs.writes.length
    const again = await walk(true)
    expect(again.every((s) => !s.stale && !s.applied && s.missing === 0 && s.extra === 0)).toBe(
      true,
    )
    expect(again.map((s) => s.packMatches)).toEqual([true, true, true])
    expect(blobs.writes).toHaveLength(writes)
    expect(await rows()).toEqual(now)
  })
})

describe('POST /api/admin/repair-stops', () => {
  function appWith(token: string) {
    const context: AdminContext = {
      token: () => token,
      db: () => db,
      store: () => store,
      settings: () => ({ sessionKey: '', typesafeToken: '', origins: '' }),
    }
    return new H3().post('/api/admin/repair-stops', defineAdminRepairStopsHandlerWith(context))
  }
  const post = (app: H3, body: unknown) =>
    app.request(`${ORIGIN}/api/admin/repair-stops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('answers 404 without an admin token and 403 for another one', async () => {
    expect((await post(appWith(''), { token: TOKEN })).status).toBe(404)
    expect((await post(appWith(TOKEN), { token: `${TOKEN}x` })).status).toBe(403)
  })

  it('answers 400 for a malformed body or a cursor naming no checked stop', async () => {
    const app = appWith(TOKEN)
    for (const body of [
      { token: TOKEN, apply: 'yes' },
      { token: TOKEN, cursor: { next: -1, corrected: {} } },
      { token: TOKEN, cursor: { next: 9, corrected: {} } },
      {
        token: TOKEN,
        cursor: { next: 1, corrected: { [settled[2]!.id]: settled[2]!.revealedKey } },
      },
      {
        token: TOKEN,
        cursor: { next: 2, corrected: { [settled[1]!.id]: 'segments/x/manifest.json' } },
      },
    ]) {
      const answer = await post(app, body)
      expect(answer.status).toBe(400)
    }
  })

  it('answers a dry run by default, uncached', async () => {
    const answer = await post(appWith(TOKEN), { token: TOKEN })
    expect(answer.status).toBe(200)
    expect(answer.headers.get('cache-control')).toContain('no-store')
    const report = (await answer.json()) as StopRepairReport
    expect(report.apply).toBe(false)
    expect(report.stops.map((s) => s.index)).toEqual([0, 1, 2])
    expect(report.cursor).toBeNull()
  })
})
