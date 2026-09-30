import { eq } from 'drizzle-orm'
import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { mission } from '#server/database/schema'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { listStops } from '#server/repositories/stops'
import { defineAdminStatusHandlerWith } from '#server/utils/admin/access'
import { defineAdminSeedHandlerWith } from '#server/utils/admin/seed'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { createTestDb, memoryStore, tableCounts } from '../mission/helpers'
import { adminAndVisitor, adminContext, as, ORIGIN } from './helpers'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
let admin: string
let visitor: string
beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  const accounts = await adminAndVisitor(db)
  admin = accounts.admin.id
  visitor = accounts.visitor.id
})
afterAll(() => close())

const { store, blobs } = memoryStore()

function app() {
  const context = adminContext(
    () => db,
    () => store,
  )
  return new H3()
    .post('/api/admin/seed', defineAdminSeedHandlerWith(context))
    .get('/api/admin/status', defineAdminStatusHandlerWith(context))
}

function seed(userId: string | undefined, body?: unknown) {
  return app().request(`${ORIGIN}/api/admin/seed`, {
    method: 'POST',
    headers: { ...as(userId), ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function status(userId?: string) {
  const answer = await app().request(`${ORIGIN}/api/admin/status`, { headers: as(userId) })
  expect(answer.status).toBe(200)
  expect(answer.headers.get('cache-control')).toContain('no-store')
  return answer.json()
}

/** Runs `refused` and checks it wrote no row and no blob. */
async function writesNothing(refused: () => Promise<void>) {
  const counts = await tableCounts(db)
  const writes = blobs.writes.length
  await refused()
  expect(await tableCounts(db)).toEqual(counts)
  expect(blobs.writes).toHaveLength(writes)
}

describe('admin status', () => {
  it('says whether the caller is an admin, and to an admin only whether a mission is active', async () => {
    expect(await status()).toEqual({ admin: false })
    expect(await status(visitor)).toEqual({ admin: false })
    expect(await status(admin)).toEqual({ admin: true, missionActive: false })
  })
})

describe('POST /api/admin/seed', () => {
  it('answers 404 to a visitor signed out or not listed', async () => {
    await writesNothing(async () => {
      for (const userId of [undefined, visitor]) {
        expect((await seed(userId, { seed: 'gale' })).status).toBe(404)
      }
    })
  })

  it('answers 400 naming the field for a malformed landing', async () => {
    await writesNothing(async () => {
      for (const [body, field] of [
        [{ seed: '' }, 'seed'],
        [{ x: '1' }, 'x'],
        [{ y: null }, 'y'],
      ] as const) {
        const answer = await seed(admin, body)
        expect(answer.status).toBe(400)
        expect((await answer.json()).message).toContain(`${field}:`)
      }
    })
  })

  it('lands a mission at the given point with the default world and rules', async () => {
    const answer = await seed(admin, { seed: 'gale', x: 12, y: -8 })
    expect(answer.status).toBe(201)
    const landed = await answer.json()
    expect(Object.keys(landed).sort()).toEqual(['missionId', 'roundId', 'stopId', 'worldHash'])

    const created = await getMission(db, landed.missionId)
    expect(created).toMatchObject({
      seed: 'gale',
      status: 'active',
      currentStopId: landed.stopId,
      worldHash: landed.worldHash,
      config: { world: {}, rules: DEFAULT_MISSION_RULES },
    })
    const [stop] = await listStops(db, created.id)
    expect(stop).toMatchObject({ id: landed.stopId, index: 0, x: 12, y: -8 })
    expect((await getOpenRound(db, created.id))?.id).toBe(landed.roundId)
    expect(await store.has(stop!.manifestKey)).toBe(true)
    expect(await status(admin)).toEqual({ admin: true, missionActive: true })
  })

  it('answers 409 MISSION_ACTIVE while a mission is active, and lands again once it has ended', async () => {
    await writesNothing(async () => {
      const answer = await seed(admin)
      expect(answer.status).toBe(409)
      expect(await answer.json()).toMatchObject({ status: 409, code: 'MISSION_ACTIVE' })
    })

    await db.update(mission).set({ status: 'ended' }).where(eq(mission.status, 'active'))
    expect(await status(admin)).toEqual({ admin: true, missionActive: false })
    const answer = await seed(admin)
    expect(answer.status).toBe(201)
    expect((await getMission(db, (await answer.json()).missionId)).seed).toBe('mars')
  })
})
