import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { userAccount } from '#server/database/schema'
import { useDB } from '#server/utils/db'
import { findOrCreateDevUser } from '~~/modules/dev/runtime/server/utils/login'
import {
  prepareLocalDatabase,
  RemoteDatabaseError,
} from '~~/modules/dev/runtime/server/utils/migrate'
import { copyMigrations, startLocalDatabase } from './helpers'

let local: Awaited<ReturnType<typeof startLocalDatabase>>
let migrations: Awaited<ReturnType<typeof copyMigrations>>

beforeAll(async () => {
  local = await startLocalDatabase()
  migrations = await copyMigrations()
})
afterAll(async () => {
  await migrations.remove()
  await local.stop()
})
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await local.reset()
  await prepareLocalDatabase(local.url, migrations.dir)
})

describe('findOrCreateDevUser', () => {
  it('creates dev:<handle> once and finds it after', async () => {
    const first = await findOrCreateDevUser(local.url, 'ada')
    expect(first).toMatchObject({ displayName: 'ada', handle: 'dev:ada' })
    expect(await findOrCreateDevUser(local.url, 'ada')).toEqual(first)
  })

  it('writes nothing to a database that is not on this machine', async () => {
    await expect(
      findOrCreateDevUser('postgres://user:secret@db.example.com/neondb', 'ada'),
    ).rejects.toBeInstanceOf(RemoteDatabaseError)
    const rows = await useDB().select().from(userAccount).where(eq(userAccount.handle, 'dev:ada'))
    expect(rows).toEqual([])
  })
})
