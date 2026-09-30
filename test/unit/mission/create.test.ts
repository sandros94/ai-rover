import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { listRoundSubmissions } from '#server/repositories/submissions'
import { listStops } from '#server/repositories/stops'
import { createMissionAtStop } from '#server/utils/mission/create'
import { tickMission } from '#server/utils/mission/tick'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { parseStopManifest } from '#shared/utils/terrain'
import { createTestDb, fakeJev, memoryStore, T0, tableCounts } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('createMissionAtStop', () => {
  it('lands stop 0, makes it current and opens round 0 with no submissions', async () => {
    const { store, blobs } = memoryStore()
    const { mission, stop, round, published } = await createMissionAtStop(db, {
      store,
      seed: 'mars',
      at: { x: 10, y: -20 },
      now: T0,
    })
    expect(mission).toMatchObject({
      seed: 'mars',
      status: 'active',
      currentStopId: stop.id,
      solsEpoch: T0,
      config: { world: {}, rules: DEFAULT_MISSION_RULES },
    })
    expect(stop).toMatchObject({
      index: 0,
      x: 10,
      y: -20,
      headingRad: 0,
      fromSegmentId: null,
      manifestKey: published.keys.manifestKey,
      revealedKey: published.keys.revealedKey,
    })
    expect(stop.manifestKey).toMatch(
      new RegExp(`^missions/${mission.id}/stops/landing\\.[0-9a-f]{16}\\.json$`),
    )
    expect(round).toMatchObject({
      fromStopId: stop.id,
      anchorX: 10,
      anchorY: -20,
      status: 'open',
      opensAt: T0,
      closesAt: null,
    })
    expect((await getOpenRound(db, mission.id))?.id).toBe(round.id)
    expect(await listRoundSubmissions(db, round.id)).toEqual([])
    expect(await listStops(db, mission.id)).toHaveLength(1)
    const manifest = parseStopManifest(await store.getJson(stop.manifestKey))
    expect(manifest.stop).toEqual({ x: 10, y: -20 })
    expect(manifest.revealedKey).toBe(stop.revealedKey)
    expect(manifest.missionId).toBe(mission.id)
    expect(blobs.blobs.has(stop.revealedKey)).toBe(true)
  })

  it('leaves nothing for a tick to do', async () => {
    const { store, blobs } = memoryStore()
    const { mission } = await createMissionAtStop(db, {
      store,
      seed: 'mars',
      at: { x: 0, y: 0 },
      now: T0,
    })
    const before = await tableCounts(db)
    const writes = blobs.writes.length
    const jev = fakeJev().client
    const result = await tickMission(db, { store, jev, missionId: mission.id, now: T0 })
    expect(result).toEqual({ settled: null, closed: null, started: null, opened: null })
    expect(await tableCounts(db)).toEqual(before)
    expect(blobs.writes).toHaveLength(writes)
    expect((await getMission(db, mission.id)).currentStopId).toBe(mission.currentStopId)
  })
})
