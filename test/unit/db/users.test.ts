import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { isUUIDv7 } from 'unsecure/uuid'
import type { DB } from '#server/database/db'
import { segmentFlag, submissionLike } from '#server/database/schema'
import { flagSegment } from '#server/repositories/flags'
import { countLikes, like } from '#server/repositories/likes'
import { openRound } from '#server/repositories/rounds'
import {
  countUserRoundSubmissions,
  createSubmission,
  getSubmission,
} from '#server/repositories/submissions'
import type { ProvenIdentity } from '#server/repositories/users'
import {
  createUser,
  createUserWithIdentity,
  findUser,
  findUserByIdentity,
  linkIdentity,
  listIdentities,
  mergeUsers,
  recordSignIn,
  setPrimaryProvider,
  unlinkIdentity,
} from '#server/repositories/users'
import {
  createTestDb,
  dbErrorOf,
  JOURNEY_T0,
  seedJourney,
  seedMission,
  submissionInput,
} from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

let serial = 0
/** A proven identity with a fresh subject. */
function proven(
  provider: ProvenIdentity['provider'],
  displayName: string,
  extra: Partial<ProvenIdentity['profile']> = {},
): ProvenIdentity {
  return {
    provider,
    subject: `${provider}-${++serial}`,
    profile: { displayName, avatarUrl: null, handle: null, ...extra },
  }
}

describe('users', () => {
  it('creates a user with a v7 id and optional fields null', async () => {
    const user = await createUser(db, { displayName: 'Ada' })
    expect(isUUIDv7(user.id)).toBe(true)
    expect(user).toMatchObject({
      displayName: 'Ada',
      avatarUrl: null,
      handle: null,
      primaryProvider: null,
    })
    expect(user.createdAt).toBeInstanceOf(Date)
  })

  it('creates a user from an identity, which becomes its primary', async () => {
    const identity = proven('atproto', 'grace.example', {
      avatarUrl: 'https://example.com/g.png',
      handle: 'grace.example',
    })
    expect(await findUserByIdentity(db, identity)).toBeUndefined()
    const user = await createUserWithIdentity(db, identity)
    expect(user).toMatchObject({ ...identity.profile, primaryProvider: 'atproto' })
    expect(await findUserByIdentity(db, identity)).toEqual(user)
    expect(await listIdentities(db, user.id)).toEqual([
      expect.objectContaining({ provider: 'atproto', subject: identity.subject, userId: user.id }),
    ])
  })

  it('records the profile of each sign-in, shown only when it is the primary identity', async () => {
    const github = proven('github', 'Octo')
    const user = await createUserWithIdentity(db, github)
    const discord = proven('discord', 'Nelly')
    await linkIdentity(db, user.id, discord)

    const renamed = await recordSignIn(db, {
      ...github,
      profile: { ...github.profile, displayName: 'Octo Cat' },
    })
    expect(renamed).toMatchObject({ id: user.id, displayName: 'Octo Cat' })
    const unchanged = await recordSignIn(db, {
      ...discord,
      profile: { ...discord.profile, displayName: 'Nelly B' },
    })
    expect(unchanged).toMatchObject({ id: user.id, displayName: 'Octo Cat' })
    expect((await listIdentities(db, user.id)).map((i) => i.displayName)).toEqual([
      'Octo Cat',
      'Nelly B',
    ])
    expect(await recordSignIn(db, proven('github', 'Nobody'))).toBeUndefined()
  })
})

describe('linking', () => {
  it('attaches an unclaimed identity, idempotently', async () => {
    const user = await createUserWithIdentity(db, proven('github', 'Linus'))
    const discord = proven('discord', 'Linus D')
    const first = await linkIdentity(db, user.id, discord)
    expect(await linkIdentity(db, user.id, discord)).toEqual(first)
    expect(await findUserByIdentity(db, discord)).toMatchObject({
      id: user.id,
      displayName: 'Linus',
      primaryProvider: 'github',
    })
  })

  it('makes the first identity of an account without one its primary', async () => {
    const dev = await createUser(db, { displayName: 'dev', handle: 'dev:dev' })
    await linkIdentity(db, dev.id, proven('discord', 'Dev D', { handle: 'devd' }))
    expect(await findUser(db, dev.id)).toMatchObject({
      primaryProvider: 'discord',
      displayName: 'Dev D',
      handle: 'devd',
    })
  })

  it('refuses an identity of another user, and a second one of the same provider', async () => {
    const a = await createUserWithIdentity(db, proven('atproto', 'A'))
    const b = await createUserWithIdentity(db, proven('atproto', 'B'))
    const github = proven('github', 'A gh')
    await linkIdentity(db, a.id, github)
    expect((await dbErrorOf(linkIdentity(db, b.id, github)))?.code).toBe('INVALID_STATE')
    expect((await dbErrorOf(linkIdentity(db, a.id, proven('github', 'A2'))))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it('refuses to link an unknown user', async () => {
    const error = await dbErrorOf(
      linkIdentity(db, '01900000-0000-7000-8000-000000000000', proven('github', 'X')),
    )
    expect(error?.code).toBe('NOT_FOUND')
  })
})

describe('the primary identity', () => {
  it('switches the name and avatar to the chosen identity', async () => {
    const user = await createUserWithIdentity(db, proven('github', 'Octo'))
    await linkIdentity(
      db,
      user.id,
      proven('discord', 'Nelly', { avatarUrl: 'https://cdn.test/n.png', handle: 'nelly' }),
    )
    expect(await setPrimaryProvider(db, user.id, 'discord')).toMatchObject({
      primaryProvider: 'discord',
      displayName: 'Nelly',
      avatarUrl: 'https://cdn.test/n.png',
      handle: 'nelly',
    })
    expect((await dbErrorOf(setPrimaryProvider(db, user.id, 'atproto')))?.code).toBe('NOT_FOUND')
  })
})

describe('unlinking', () => {
  it('refuses the last identity', async () => {
    const user = await createUserWithIdentity(db, proven('github', 'Solo'))
    expect((await dbErrorOf(unlinkIdentity(db, user.id, 'github')))?.code).toBe('INVALID_STATE')
    expect((await dbErrorOf(unlinkIdentity(db, user.id, 'discord')))?.code).toBe('NOT_FOUND')
    expect(await listIdentities(db, user.id)).toHaveLength(1)
  })

  it('hands the primary to the oldest remaining identity', async () => {
    const user = await createUserWithIdentity(db, proven('github', 'Octo'))
    await linkIdentity(db, user.id, proven('discord', 'Nelly'))
    await linkIdentity(db, user.id, proven('atproto', 'n.example'))
    const after = await unlinkIdentity(db, user.id, 'github')
    expect(after).toMatchObject({ primaryProvider: 'discord', displayName: 'Nelly' })
    expect((await listIdentities(db, user.id)).map((i) => i.provider)).toEqual([
      'discord',
      'atproto',
    ])
  })
})

describe('merging', () => {
  it('moves identities, submissions, likes and flags, collapsing shared likes, and deletes the old account', async () => {
    const { mission, reached, user: ada, driving } = await seedJourney(db)
    const round = await openRound(db, {
      missionId: mission.id,
      fromStopId: reached.id,
      anchor: reached,
    })
    const bob = await createUserWithIdentity(db, proven('discord', 'Bob'))
    const current = await createUserWithIdentity(db, proven('github', 'Ada gh'))

    // `bob` submitted to the open round; the current account and `ada` LGTM it.
    const theirs = await createSubmission(db, submissionInput(round, bob.id, { x: 10, y: 80 }))
    await like(db, theirs.id, { userId: current.id })
    await like(db, theirs.id, { userId: ada.id })
    // Both LGTM a submission of `ada`'s: the likes collapse into one.
    const shared = await createSubmission(db, submissionInput(round, ada.id, { x: -10, y: 80 }))
    await like(db, shared.id, { userId: bob.id })
    await like(db, shared.id, { userId: current.id })
    const now = new Date(JOURNEY_T0.getTime() + 4 * 3_600_000 + 60_000)
    await flagSegment(db, driving.id, { userId: bob.id, now })
    await flagSegment(db, driving.id, { userId: current.id, now: new Date(now.getTime() - 1) })

    const merged = await mergeUsers(db, { into: current.id, from: bob.id })
    expect(merged).toMatchObject({
      id: current.id,
      displayName: 'Ada gh',
      primaryProvider: 'github',
    })
    expect(await findUser(db, bob.id)).toBeUndefined()
    expect((await listIdentities(db, current.id)).map((i) => i.provider).toSorted()).toEqual([
      'discord',
      'github',
    ])

    expect(await getSubmission(db, theirs.id)).toMatchObject({ userId: current.id, status: 'open' })
    // `bob`'s own LGTM and the current account's collapse; `ada`'s stays.
    expect(await countLikes(db, theirs.id)).toBe(2)
    expect(await countLikes(db, shared.id)).toBe(2)
    const sharedLikers = await db
      .select({ userId: submissionLike.userId })
      .from(submissionLike)
      .where(eq(submissionLike.submissionId, shared.id))
    expect(sharedLikers.map((l) => l.userId).toSorted()).toEqual([ada.id, current.id].toSorted())
    expect(await countUserRoundSubmissions(db, { roundId: round.id, userId: current.id })).toBe(1)

    const flags = await db.select().from(segmentFlag).where(eq(segmentFlag.segmentId, driving.id))
    expect(flags).toEqual([expect.objectContaining({ userId: current.id, createdAt: now })])
  })

  it("withdraws the old account's open submission where the current one has its own", async () => {
    const { round } = await seedMission(db)
    const a = await createUserWithIdentity(db, proven('github', 'A'))
    const b = await createUserWithIdentity(db, proven('discord', 'B'))
    const kept = await createSubmission(db, submissionInput(round, a.id, { x: 5, y: 60 }))
    const dropped = await createSubmission(db, submissionInput(round, b.id, { x: -5, y: 60 }))
    await mergeUsers(db, { into: a.id, from: b.id })
    expect(await getSubmission(db, kept.id)).toMatchObject({ status: 'open', userId: a.id })
    expect(await getSubmission(db, dropped.id)).toMatchObject({
      status: 'withdrawn',
      userId: a.id,
    })
    expect(await countLikes(db, dropped.id)).toBe(0)
    expect(await countUserRoundSubmissions(db, { roundId: round.id, userId: a.id })).toBe(2)
  })

  it('refuses two accounts holding the same provider, and an account into itself', async () => {
    const a = await createUserWithIdentity(db, proven('github', 'A'))
    const b = await createUserWithIdentity(db, proven('github', 'B'))
    expect((await dbErrorOf(mergeUsers(db, { into: a.id, from: b.id })))?.code).toBe(
      'INVALID_STATE',
    )
    expect(await findUser(db, b.id)).toBeDefined()
    expect((await dbErrorOf(mergeUsers(db, { into: a.id, from: a.id })))?.code).toBe(
      'INVALID_STATE',
    )
  })

  it("gives an account without identities the old account's primary", async () => {
    const dev = await createUser(db, { displayName: 'dev' })
    const b = await createUserWithIdentity(db, proven('discord', 'Bee'))
    expect(await mergeUsers(db, { into: dev.id, from: b.id })).toMatchObject({
      primaryProvider: 'discord',
      displayName: 'Bee',
    })
  })
})
