import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDB } from '#server/utils/db'
import { createJourneyStore } from '#server/utils/journey/store'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { listStops } from '#server/repositories/stops'
import { prepareLocalDatabase } from '~~/modules/dev-db/runtime/server/utils/migrate'
import { seedLocalMission } from '~~/modules/dev-db/runtime/server/utils/seed'
import { databaseStatus } from '~~/modules/dev-db/runtime/server/utils/status'
import { MemoryBlobs } from '../journey/helpers'
import { copyMigrations, INIT, startLocalDatabase } from './helpers'

let local: Awaited<ReturnType<typeof startLocalDatabase>>
let migrations: Awaited<ReturnType<typeof copyMigrations>>

beforeAll(async () => (local = await startLocalDatabase()))
afterAll(() => local.stop())
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await local.reset()
  migrations = await copyMigrations()
  await prepareLocalDatabase(local.url, migrations.dir)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await migrations.remove()
})

describe('seedLocalMission', () => {
  it('lands a mission at stop 0 with an open round and its terrain published', async () => {
    const blobs = new MemoryBlobs()
    const seeded = await seedLocalMission(local.url, migrations.dir, {
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

  it('refuses a second mission unless forced, and a forced seed starts from a reset', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    const first = await seedLocalMission(local.url, migrations.dir, { store })
    await expect(seedLocalMission(local.url, migrations.dir, { store })).rejects.toThrow(
      /already has a mission.*force/,
    )

    const second = await seedLocalMission(local.url, migrations.dir, { store, force: true })
    expect(second.missionId).not.toBe(first.missionId)
    expect(await useDB().execute(sql`select id from mission`)).toMatchObject({
      rows: [{ id: second.missionId }],
    })
  })

  it('refuses a database that is not on this machine', async () => {
    await expect(
      seedLocalMission('postgres://db.example.com/neondb', migrations.dir, {
        store: createJourneyStore({ store: new MemoryBlobs() }),
      }),
    ).rejects.toThrow(/not on this machine/)
  })
})

describe('databaseStatus', () => {
  it('reports the host, the applied and pending migrations, table counts and blob keys', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await seedLocalMission(local.url, migrations.dir, { store })

    const status = await databaseStatus(local.url, migrations.dir, store)
    expect(status).toMatchObject({
      url: new URL(local.url).host,
      loopback: true,
      ready: true,
      refusal: null,
      pending: [],
      blobs: { store: 'journey', keys: blobs.blobs.size },
    })
    expect(status.applied).toEqual([
      {
        name: INIT,
        recordedAt: expect.any(String),
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileDigest: status.applied[0]!.digest,
        drifted: false,
      },
    ])
    expect(status.counts).toMatchObject({ mission: 1, stop: 1, round: 1, submission: 0 })
    expect(JSON.stringify(status)).not.toContain('postgres://')
  })

  it('is not ready while a migration is pending', async () => {
    const next = join(migrations.dir, '29990101000000_next')
    await mkdir(next)
    await writeFile(join(next, 'migration.sql'), 'select 1;')

    const status = await databaseStatus(
      local.url,
      migrations.dir,
      createJourneyStore({ store: new MemoryBlobs() }),
    )
    expect(status).toMatchObject({ ready: false, refusal: null, pending: ['29990101000000_next'] })
  })

  it('marks a drifted migration and carries the refusal', async () => {
    await useDB().execute(sql`update jev_dev.migration_digest set digest = 'tampered'`)
    await prepareLocalDatabase(local.url, migrations.dir)

    const status = await databaseStatus(
      local.url,
      migrations.dir,
      createJourneyStore({ store: new MemoryBlobs() }),
    )
    expect(status.ready).toBe(false)
    expect(status.refusal).toContain('was edited after this database applied it')
    expect(status.applied[0]).toMatchObject({ name: INIT, digest: 'tampered', drifted: true })
  })
})
