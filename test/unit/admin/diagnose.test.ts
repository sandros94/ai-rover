import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import type { AdminContext, AdminSettings } from '#server/utils/admin/access'
import type { Diagnosis } from '#shared/utils/admin'
import { defineAdminDiagnoseHandlerWith } from '#server/utils/admin/diagnose'
import { createJourneyStore } from '#server/utils/journey/store'
import { MIGRATIONS_DIR } from '../db/helpers'
import { MemoryBlobs } from '../journey/helpers'
import { createTestDb, memoryStore, users } from '../mission/helpers'
import { readdir } from 'node:fs/promises'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const TOKEN = 'operator-token-for-tests-0123456789'
const ORIGIN = 'https://jev.test'
const SETTINGS: AdminSettings = {
  sessionKey: 'a-session-secret-of-at-least-32-characters',
  typesafeToken: '',
  origins: ORIGIN,
}

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

function appWith(context: Partial<AdminContext> & { token?: () => string }) {
  const { store } = memoryStore()
  return new H3().post(
    '/api/admin/diagnose',
    defineAdminDiagnoseHandlerWith({
      token: () => TOKEN,
      db: () => db,
      store: () => store,
      settings: () => SETTINGS,
      ...context,
    }),
  )
}

function diagnose(app: H3, body: unknown) {
  return app.request(`${ORIGIN}/api/admin/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function diagnosis(app: H3): Promise<Diagnosis> {
  const answer = await diagnose(app, { token: TOKEN })
  expect(answer.status).toBe(200)
  expect(answer.headers.get('cache-control')).toContain('no-store')
  return answer.json()
}

/** A database whose every query fails the way a refused connection does. */
function failingDb(): DB {
  const refused = Object.assign(
    new Error('password authentication failed for user "jev" at db.internal:5432'),
    { code: '28P01' },
  )
  class DrizzleQueryError extends Error {}
  const fail = () => {
    throw new DrizzleQueryError('Failed query: select 1 -- postgres://jev:hunter2@db', {
      cause: refused,
    })
  }
  return new Proxy({} as DB, { get: () => fail })
}

describe('POST /api/admin/diagnose', () => {
  it('answers 404 when no admin token is configured, whatever the body', async () => {
    for (const body of [{ token: '' }, { token: TOKEN }, {}]) {
      expect((await diagnose(appWith({ token: () => '' }), body)).status).toBe(404)
    }
  })

  it('answers 403 when the token is missing or does not match', async () => {
    const app = appWith({})
    for (const body of [{}, { token: '' }, { token: `${TOKEN}x` }, { token: 42 }, null]) {
      expect((await diagnose(app, body)).status).toBe(403)
    }
  })

  it('reports applied migrations, app table counts, blob keys and runtime settings', async () => {
    await users(db, 'Ada', 'Grace')
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await store.putJson('missions/m-1/stops/0.json', {})
    await store.putJson('terrain/w/chunks/0_0.bin', {})
    await store.putJson('elsewhere/x.json', {})

    const answer = await diagnosis(appWith({ store: () => store }))
    const migrations = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(answer.database).toEqual({
      ok: true,
      migrations,
      tables: expect.objectContaining({ user_account: 2, mission: 0, jev_judgment: 0 }),
    })
    expect(Object.keys(answer.database.tables)).toHaveLength(11)
    expect(answer.blobs).toEqual({ ok: true, keys: 2 })
    expect(answer.runtime).toEqual({
      node: process.version,
      ...(process.env.AWS_REGION && { region: process.env.AWS_REGION }),
      hasSessionKey: true,
      hasTypesafeToken: false,
      originsConfigured: true,
    })
  })

  it('reports a failing database by error class and Postgres code only', async () => {
    const answer = await diagnosis(appWith({ db: failingDb }))
    expect(answer.database).toEqual({
      ok: false,
      error: 'DrizzleQueryError (28P01)',
      migrations: [],
      tables: {},
    })
    expect(JSON.stringify(answer)).not.toMatch(/hunter2|db\.internal|password|Failed query/)
    expect(answer.blobs.ok).toBe(true)
  })

  it('reports a failing blob store without failing the other sections', async () => {
    const blobs = new MemoryBlobs()
    blobs.list = () => Promise.reject(new TypeError('fetch failed: https://blobs.internal/x'))
    const answer = await diagnosis(appWith({ store: () => createJourneyStore({ store: blobs }) }))
    expect(answer.blobs).toEqual({ ok: false, error: 'TypeError', keys: 0 })
    expect(answer.database.ok).toBe(true)
  })

  it('caps the blob key count at 1000', async () => {
    const blobs = new MemoryBlobs()
    for (let k = 0; k < 1001; k++)
      blobs.blobs.set(`missions/m/${k}`, { data: new ArrayBuffer(0), metadata: {} })
    const answer = await diagnosis(appWith({ store: () => createJourneyStore({ store: blobs }) }))
    expect(answer.blobs).toEqual({ ok: true, keys: 1000 })
  })
})
