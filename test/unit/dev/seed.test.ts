import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDB } from '#server/utils/db'
import { createJourneyStore } from '#server/utils/journey/store'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { listStops } from '#server/repositories/stops'
import { RemoteDatabaseError } from '~~/modules/dev/runtime/server/utils/loopback'
import { MissionExistsError, seedLocalMission } from '~~/modules/dev/runtime/server/utils/seed'
import { MemoryBlobs } from '../journey/helpers'
import { startLocalDatabase } from './helpers'

let local: Awaited<ReturnType<typeof startLocalDatabase>>

beforeAll(async () => (local = await startLocalDatabase()))
afterAll(() => local.stop())
beforeEach(() => local.reset())

describe('seedLocalMission', () => {
  it('lands a mission at stop 0 with an open round and its terrain published', async () => {
    const blobs = new MemoryBlobs()
    const seeded = await seedLocalMission(local.url, {
      store: createJourneyStore({ store: blobs }),
      seed: 'mars',
      x: 10,
      y: -20,
    })

    const mission = await getMission(useDB(), seeded.missionId)
    expect(mission).toMatchObject({ seed: 'mars', currentStopId: seeded.stopId })
    const [stop] = await listStops(useDB(), seeded.missionId)
    expect(stop).toMatchObject({ id: seeded.stopId, index: 0, x: 10, y: -20 })
    expect((await getOpenRound(useDB(), seeded.missionId))?.id).toBe(seeded.roundId)

    expect(blobs.blobs.has(seeded.manifestKey)).toBe(true)
    expect(blobs.blobs.has(stop!.revealedKey)).toBe(true)
    expect(stop!.manifestKey).toBe(seeded.manifestKey)
    expect(seeded.bytes.count).toBe(blobs.writes.length)
    expect(seeded.bytes.stored).toBeGreaterThan(0)
    expect(seeded.bytes.stored).toBeLessThan(seeded.bytes.raw)
  })

  it('refuses a second mission, pointing at the DevTools reset, and leaves the first alone', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    const first = await seedLocalMission(local.url, { store })
    const second = seedLocalMission(local.url, { store })
    await expect(second).rejects.toBeInstanceOf(MissionExistsError)
    await expect(second).rejects.toThrow(/already has a mission.*"Reset database"/)
    expect(await useDB().execute(sql`select id from mission`, 'objects')).toEqual([
      { id: first.missionId },
    ])
  })

  it('writes nothing to a database that is not on this machine', async () => {
    const blobs = new MemoryBlobs()
    await expect(
      seedLocalMission('postgres://db.example.com/neondb', {
        store: createJourneyStore({ store: blobs }),
      }),
    ).rejects.toBeInstanceOf(RemoteDatabaseError)
    expect(await useDB().execute(sql`select id from mission`, 'objects')).toEqual([])
    expect(blobs.writes).toEqual([])
  })
})
