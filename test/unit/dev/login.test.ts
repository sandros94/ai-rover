import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { userAccount } from '#server/database/schema'
import {
  createUserWithIdentity,
  linkIdentity,
  mergeUsers,
  setPrimaryProvider,
} from '#server/repositories/users'
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

  it('signs in to the same account after it links an identity and makes it primary', async () => {
    const first = await findOrCreateDevUser(local.url, 'ada')
    await linkIdentity(useDB(), first.id, {
      provider: 'github',
      subject: '4242',
      profile: { displayName: 'Ada L.', avatarUrl: null, handle: 'ada-l' },
    })
    await setPrimaryProvider(useDB(), first.id, 'github')
    const again = await findOrCreateDevUser(local.url, 'ada')
    expect(again).toEqual({ id: first.id, displayName: 'Ada L.', handle: 'ada-l' })
  })

  it('follows its account into the one it merges into', async () => {
    const dev = await findOrCreateDevUser(local.url, 'ada')
    const other = await createUserWithIdentity(useDB(), {
      provider: 'discord',
      subject: '99',
      profile: { displayName: 'Nelly', avatarUrl: null, handle: 'nelly' },
    })
    await mergeUsers(useDB(), { into: other.id, from: dev.id })
    expect((await findOrCreateDevUser(local.url, 'ada')).id).toBe(other.id)
  })

  it('writes nothing to a database that is not on this machine', async () => {
    await expect(
      findOrCreateDevUser('postgres://user:secret@db.example.com/neondb', 'ada'),
    ).rejects.toBeInstanceOf(RemoteDatabaseError)
    const rows = await useDB().select().from(userAccount).where(eq(userAccount.handle, 'dev:ada'))
    expect(rows).toEqual([])
  })
})
