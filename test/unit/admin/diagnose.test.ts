import { sql } from 'drizzle-orm'
import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import type { AdminContext, AdminSettings } from '#server/utils/admin/access'
import { parseAdminAllowlist } from '#server/utils/admin/access'
import type { Diagnosis } from '#shared/utils/admin'
import { defineAdminDiagnoseHandlerWith, diagnoseLocks } from '#server/utils/admin/diagnose'
import { createJourneyStore } from '#server/utils/journey/store'
import { MIGRATIONS_DIR } from '../db/helpers'
import { MemoryBlobs } from '../journey/helpers'
import { createTestDb, memoryStore } from '../mission/helpers'
import { adminAndVisitor, adminContext, as, ORIGIN } from './helpers'
import { readdir } from 'node:fs/promises'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SETTINGS: AdminSettings = {
  sessionKey: 'a-session-secret-of-at-least-32-characters',
  typesafeToken: '',
  origins: ORIGIN,
}

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

function appWith(context: Partial<AdminContext> = {}) {
  const { store } = memoryStore()
  return new H3().post(
    '/api/admin/diagnose',
    defineAdminDiagnoseHandlerWith({
      ...adminContext(
        () => db,
        () => store,
      ),
      settings: () => SETTINGS,
      ...context,
    }),
  )
}

function diagnose(app: H3, userId?: string) {
  return app.request(`${ORIGIN}/api/admin/diagnose`, { method: 'POST', headers: as(userId) })
}

async function diagnosis(app: H3): Promise<Diagnosis> {
  const answer = await diagnose(app, admin)
  expect(answer.status).toBe(200)
  expect(answer.headers.get('cache-control')).toContain('no-store')
  return answer.json()
}

/** A database whose every query fails the way a refused connection does. */
function failingDb(): DB {
  const refused = Object.assign(
    new Error('password authentication failed for user "rover" at db.internal:5432'),
    { code: '28P01' },
  )
  class DrizzleQueryError extends Error {}
  const fail = () => {
    throw new DrizzleQueryError('Failed query: select 1 -- postgres://rover:hunter2@db', {
      cause: refused,
    })
  }
  return new Proxy({} as DB, { get: () => fail })
}

describe('POST /api/admin/diagnose', () => {
  it('answers 404 to a visitor signed out or not listed, and to everyone with no allowlist', async () => {
    const app = appWith()
    for (const userId of [undefined, visitor]) {
      const answer = await diagnose(app, userId)
      expect(answer.status).toBe(404)
      expect(answer.headers.get('cache-control')).toContain('no-store')
    }
    const nobody = appWith({ allowlist: () => parseAdminAllowlist('') })
    expect((await diagnose(nobody, admin)).status).toBe(404)
  })

  it('reports applied migrations, app table counts, blob keys and runtime settings', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await store.putJson('missions/m-1/stops/0.json', {})
    await store.putJson('terrain/w/chunks/0_0.bin', {})
    await store.putJson('elsewhere/x.json', {})

    const answer = await diagnosis(appWith({ store: () => store }))
    const migrations = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.slice(0, 14))
      .sort()
    expect(answer.database).toEqual({
      ok: true,
      ms: expect.any(Number),
      migrations,
      tables: expect.objectContaining({ user_account: 2, user_identity: 3, mission: 0 }),
    })
    expect(Object.keys(answer.database.tables)).toHaveLength(11)
    expect(answer.blobs).toEqual({ ok: true, ms: expect.any(Number), keys: 2 })
    expect(answer.locks).toMatchObject({ ok: true, ms: expect.any(Number), stuck: [] })
    expect(answer.mission).toEqual({ ok: true, ms: expect.any(Number), active: false })
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
      ms: expect.any(Number),
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
    expect(answer.blobs).toEqual({ ok: false, error: 'TypeError', ms: expect.any(Number), keys: 0 })
    expect(answer.database.ok).toBe(true)
  })

  it('caps the blob key count at 1000', async () => {
    const blobs = new MemoryBlobs()
    for (let k = 0; k < 1001; k++)
      blobs.blobs.set(`missions/m/${k}`, { data: new ArrayBuffer(0), metadata: {} })
    const answer = await diagnosis(appWith({ store: () => createJourneyStore({ store: blobs }) }))
    expect(answer.blobs).toEqual({ ok: true, ms: expect.any(Number), keys: 1000 })
  })
})

describe('diagnoseLocks', () => {
  it('counts the sessions by state and names one holding an advisory lock over 5 s', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let taken!: () => void
    const locked = new Promise<void>((resolve) => (taken = resolve))
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('held-by-a-test'))`)
      taken()
      await released
    })
    try {
      await locked
      const held = await diagnoseLocks(() => db, { now: new Date(Date.now() + 6_000) })
      expect(held.ok).toBe(true)
      expect(Object.values(held.states).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
      expect(held.oldestTransactionS).toBeGreaterThan(5)
      expect(held.stuck).toContainEqual(
        expect.objectContaining({
          pid: expect.any(Number),
          ageS: expect.any(Number),
          holdsAdvisoryLock: true,
        }),
      )
      expect(held.stuck[0]!.ageS).toBeGreaterThan(5)
    } finally {
      release()
      await holder
    }
    expect((await diagnoseLocks(() => db)).stuck).toEqual([])
  })

  it('reports a failing database by error class and Postgres code only', async () => {
    const answer = await diagnoseLocks(failingDb)
    expect(answer).toEqual({
      ok: false,
      error: 'DrizzleQueryError (28P01)',
      ms: expect.any(Number),
      states: {},
      oldestTransactionS: null,
      stuck: [],
    })
  })
})
