import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import type { ProvenIdentity } from '#server/repositories/users'
import {
  createUserWithIdentity,
  findUser,
  findUserByIdentity,
  listIdentities,
} from '#server/repositories/users'
import { completeSignIn, failSignIn } from '#server/utils/sign-in'
import type { CodeFlowProvider } from '~~/modules/auth/runtime/server/lib/code-flow'
import { createCodeFlowHandler } from '~~/modules/auth/runtime/server/lib/code-flow'
import type { GitHubFlow } from '~~/modules/auth/runtime/server/lib/flow'
import { createTestDb } from '../db/helpers'
import { cookieHeader, openCookie, ORIGIN, setCookies, testAuth } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

/** A provider that proves whichever subject the test names next, with no network. */
function fakeProvider() {
  const next = { subject: '', displayName: '' }
  const provider: CodeFlowProvider<GitHubFlow> = {
    provider: 'github',
    label: 'Fake',
    async authorize({ state }) {
      return { url: new URL(`https://provider.test/authorize?state=${state}`), flow: {} }
    },
    async identify() {
      return { subject: next.subject, profile: { displayName: next.displayName } }
    },
  }
  return { provider, next }
}

function appWith() {
  const auth = testAuth(globalThis.fetch)
  const { provider, next } = fakeProvider()
  const app = new H3()
    .get(
      '/api/auth/github',
      createCodeFlowHandler(
        auth,
        provider,
        { clientId: 'id', clientSecret: 'secret' },
        {
          onSuccess: (event, result) =>
            completeSignIn(event, { db, sessions: auth.sessions }, result),
          onError: (event, error) => failSignIn(event, error, auth.sessions),
        },
      ),
    )
    .post('/test/login-as/:id', async (event) => {
      await auth.sessions.set(event, {
        user: { id: event.context.params!.id!, displayName: 'Current', providers: ['discord'] },
      })
      return 'ok'
    })

  /** Runs the flow for `subject`, signed in as `as` when given, linking when `link`; `deny` refuses it at the provider. */
  async function run(
    subject: string,
    options: { as?: string; link?: boolean; deny?: boolean } = {},
  ) {
    next.subject = subject
    next.displayName = `gh ${subject}`
    const login = options.as
      ? await app.request(`${ORIGIN}/test/login-as/${options.as}`, { method: 'POST' })
      : undefined
    const jar = login ? [login] : []
    const started = await app.request(
      `${ORIGIN}/api/auth/github?redirect=/settings${options.link ? '&link' : ''}`,
      { headers: { cookie: cookieHeader(...jar) } },
    )
    expect(started.status).toBe(302)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')
    const answer = options.deny ? 'error=access_denied' : 'code=c'
    const callback = await app.request(`${ORIGIN}/api/auth/github?${answer}&state=${state}`, {
      headers: { cookie: cookieHeader(...jar, started) },
    })
    const session = setCookies(callback)['__Host-rover-session']
    return {
      status: callback.status,
      location: callback.headers.get('location'),
      claims: session?.value ? await openCookie(session.value) : undefined,
    }
  }
  return { run }
}

function discord(displayName: string, subject: string): ProvenIdentity {
  return { provider: 'discord', subject, profile: { displayName, avatarUrl: null, handle: null } }
}

describe('completing a sign-in', () => {
  it('creates an account for an unknown identity and signs into it', async () => {
    const { run } = appWith()
    const { location, claims } = await run('101')
    expect(location).toBe('/settings')
    const user = await findUserByIdentity(db, { provider: 'github', subject: '101' })
    expect(user).toMatchObject({ displayName: 'gh 101', primaryProvider: 'github' })
    expect(claims).toMatchObject({ sub: user!.id, providers: ['github'] })
  })

  it('attaches an unclaimed identity to the signed-in account when linking', async () => {
    const { run } = appWith()
    const current = await createUserWithIdentity(db, discord('Current', 'd-102'))
    const { location, claims } = await run('102', { as: current.id, link: true })
    expect(location).toBe('/settings')
    expect(await findUserByIdentity(db, { provider: 'github', subject: '102' })).toMatchObject({
      id: current.id,
      displayName: 'Current',
    })
    expect(claims).toMatchObject({ sub: current.id, providers: ['discord', 'github'] })
  })

  it("merges the identity's account into the signed-in one when linking", async () => {
    const { run } = appWith()
    await run('103')
    const other = (await findUserByIdentity(db, { provider: 'github', subject: '103' }))!
    const current = await createUserWithIdentity(db, discord('Current', 'd-103'))
    const { claims } = await run('103', { as: current.id, link: true })
    expect(await findUser(db, other.id)).toBeUndefined()
    expect((await listIdentities(db, current.id)).map((i) => i.provider).toSorted()).toEqual([
      'discord',
      'github',
    ])
    expect(claims).toMatchObject({ sub: current.id, displayName: 'Current' })
  })

  it('signs into the holding account when not linking, whoever was signed in', async () => {
    const { run } = appWith()
    await run('104')
    const holder = (await findUserByIdentity(db, { provider: 'github', subject: '104' }))!
    const current = await createUserWithIdentity(db, discord('Current', 'd-104'))
    const { claims } = await run('104', { as: current.id })
    expect(claims).toMatchObject({ sub: holder.id, providers: ['github'] })
    expect(await findUser(db, current.id)).toBeDefined()
  })

  it('lands on the settings page with the code when a link cannot merge', async () => {
    const { run } = appWith()
    await run('105')
    const current = await createUserWithIdentity(db, {
      provider: 'github',
      subject: '105-other',
      profile: { displayName: 'Current', avatarUrl: null, handle: null },
    })
    const { status, location } = await run('105', { as: current.id, link: true })
    expect(status).toBe(302)
    expect(location).toBe('/settings?error=link-conflict')
  })

  it('lands on the login page with the code when signed out', async () => {
    const { run } = appWith()
    const { location } = await run('106', { deny: true })
    expect(location).toBe('/login?error=refused')
  })
})
