import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { getMission } from '#server/repositories/missions'
import { getOpenRound } from '#server/repositories/rounds'
import { listStops } from '#server/repositories/stops'
import type { AdminContext } from '#server/utils/admin/access'
import { defineAdminSeedHandlerWith, defineAdminStatusHandlerWith } from '#server/utils/admin/seed'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { stopManifestKey } from '#shared/utils/terrain'
import { createTestDb, memoryStore, tableCounts } from '../mission/helpers'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const TOKEN = 'operator-token-for-tests-0123456789'
const ORIGIN = 'https://rover.test'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const { store, blobs } = memoryStore()

function appWith(token: string) {
  const context: AdminContext = {
    token: () => token,
    db: () => db,
    store: () => store,
    settings: () => ({ sessionKey: '', typesafeToken: '', origins: '' }),
  }
  return new H3()
    .post('/api/admin/seed', defineAdminSeedHandlerWith(context))
    .get('/api/admin/status', defineAdminStatusHandlerWith(context))
}

function seed(app: H3, body: unknown) {
  return app.request(`${ORIGIN}/api/admin/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function nothingWritten() {
  expect(Object.values(await tableCounts(db)).every((n) => n === 0)).toBe(true)
  expect(blobs.writes).toEqual([])
}

describe('admin status', () => {
  it('says only whether an admin token is configured', async () => {
    for (const [token, configured] of [
      ['', false],
      [TOKEN, true],
    ] as const) {
      const answer = await appWith(token).request(`${ORIGIN}/api/admin/status`)
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({ configured })
      expect(answer.headers.get('cache-control')).toContain('no-store')
    }
  })
})

describe('POST /api/admin/seed', () => {
  it('answers 404 when no admin token is configured, whatever the body', async () => {
    for (const body of [{ token: '' }, { token: TOKEN }, {}]) {
      expect((await seed(appWith(''), body)).status).toBe(404)
    }
    await nothingWritten()
  })

  it('answers 403 when the token is missing or does not match', async () => {
    const app = appWith(TOKEN)
    for (const body of [{}, { token: '' }, { token: `${TOKEN}x` }, { token: 42 }, null]) {
      expect((await seed(app, body)).status).toBe(403)
    }
    await nothingWritten()
  })

  it('answers 400 naming the field for a malformed landing', async () => {
    const app = appWith(TOKEN)
    for (const [body, field] of [
      [{ token: TOKEN, seed: '' }, 'seed'],
      [{ token: TOKEN, x: '1' }, 'x'],
      [{ token: TOKEN, y: null }, 'y'],
    ] as const) {
      const answer = await seed(app, body)
      expect(answer.status).toBe(400)
      expect((await answer.json()).message).toContain(`${field}:`)
    }
    await nothingWritten()
  })

  it('lands the mission at the given point with the default world and rules', async () => {
    const answer = await seed(appWith(TOKEN), { token: TOKEN, seed: 'gale', x: 12, y: -8 })
    expect(answer.status).toBe(201)
    const landed = await answer.json()
    expect(Object.keys(landed).sort()).toEqual(['missionId', 'roundId', 'stopId', 'worldHash'])

    const mission = await getMission(db, landed.missionId)
    expect(mission).toMatchObject({
      seed: 'gale',
      status: 'active',
      currentStopId: landed.stopId,
      worldHash: landed.worldHash,
      config: { world: {}, rules: DEFAULT_MISSION_RULES },
    })
    const [stop] = await listStops(db, mission.id)
    expect(stop).toMatchObject({ id: landed.stopId, index: 0, x: 12, y: -8 })
    expect((await getOpenRound(db, mission.id))?.id).toBe(landed.roundId)
    expect(await store.has(stopManifestKey(mission.id, 0))).toBe(true)
  })

  it('answers 409 once a mission exists and changes nothing', async () => {
    const counts = await tableCounts(db)
    const writes = blobs.writes.length
    const answer = await seed(appWith(TOKEN), { token: TOKEN })
    expect(answer.status).toBe(409)
    expect(await tableCounts(db)).toEqual(counts)
    expect(blobs.writes).toHaveLength(writes)
  })
})
