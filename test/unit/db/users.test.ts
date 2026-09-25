import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isUUIDv7 } from 'unsecure/uuid'
import type { DB } from '#server/database/db'
import { createUser, findUserByIdentity, linkIdentity } from '#server/repositories/users'
import { createTestDb, dbErrorOf } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('users', () => {
  it('creates a user with a v7 id and optional fields null', async () => {
    const user = await createUser(db, { displayName: 'Ada' })
    expect(isUUIDv7(user.id)).toBe(true)
    expect(user).toMatchObject({ displayName: 'Ada', avatarUrl: null, handle: null })
    expect(user.createdAt).toBeInstanceOf(Date)
  })

  it('finds a user by a linked identity', async () => {
    const user = await createUser(db, {
      displayName: 'Grace',
      avatarUrl: 'https://example.com/g.png',
      handle: 'grace.example',
    })
    const identity = { provider: 'atproto', subject: 'did:plc:grace' } as const
    expect(await findUserByIdentity(db, identity)).toBeUndefined()
    await linkIdentity(db, user.id, identity)
    expect(await findUserByIdentity(db, identity)).toEqual(user)
    expect(await findUserByIdentity(db, { provider: 'github', subject: 'did:plc:grace' })).toBe(
      undefined,
    )
  })

  it('links the same identity to the same user idempotently', async () => {
    const user = await createUser(db, { displayName: 'Linus' })
    const identity = { provider: 'github', subject: '42' } as const
    const first = await linkIdentity(db, user.id, identity)
    const second = await linkIdentity(db, user.id, identity)
    expect(second).toEqual(first)
  })

  it('refuses an identity already linked to another user', async () => {
    const a = await createUser(db, { displayName: 'A' })
    const b = await createUser(db, { displayName: 'B' })
    const identity = { provider: 'github', subject: '7' } as const
    await linkIdentity(db, a.id, identity)
    const error = await dbErrorOf(linkIdentity(db, b.id, identity))
    expect(error?.code).toBe('INVALID_STATE')
  })

  it('refuses to link an unknown user', async () => {
    const error = await dbErrorOf(
      linkIdentity(db, '01900000-0000-7000-8000-000000000000', {
        provider: 'github',
        subject: '9',
      }),
    )
    expect(error?.code).toBe('NOT_FOUND')
  })
})
