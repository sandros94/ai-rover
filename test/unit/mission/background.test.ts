import { hkdf } from 'unsecure/hkdf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DispatchFetch } from '#server/utils/mission/background'
import {
  createTickDispatcher,
  isMissionDue,
  isTickAuthorized,
  purgeMissionCache,
  runTickRequest,
  TICK_FUNCTION_PATH,
  tickToken,
} from '#server/utils/mission/background'
import type { TickResult } from '#server/utils/mission/tick'
import { tickMission } from '#server/utils/mission/tick'
import entry from '~~/netlify/functions/mission-tick-background.mts'

const purge = vi.hoisted(() =>
  vi.fn<(options: { tags: string[] }) => Promise<void>>(async () => {}),
)
vi.mock('@netlify/functions', () => ({ purgeCache: purge }))

const IDLE: TickResult = { settled: null, closed: null, started: null, opened: null }
const fakeDb = vi.hoisted(() => ({ fake: 'db' }))
vi.mock('#server/utils/mission/tick', () => ({
  tickMission: vi.fn<typeof tickMission>(async () => IDLE),
}))
vi.mock('#server/utils/db', () => ({ useDB: () => fakeDb }))
vi.mock('#server/utils/journey/store', () => ({ createJourneyStore: () => ({}) }))

const SECRET = 'Tg4hW9qLz2Nc7Vb1Xm5Rk8Pd3Js6Fy0AeQx'
const DEV_SEED = 'ai-rover development session key'

afterEach(() => {
  vi.mocked(tickMission).mockClear()
  purge.mockClear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the tick token', () => {
  it('is HKDF of the session key under its own info', async () => {
    const token = await tickToken(SECRET, false)
    expect(token).toBe(
      await hkdf(SECRET, { length: 32, info: 'rover-tick', returnAs: 'base64url' }),
    )
    expect(token).not.toBe(
      await hkdf(SECRET, { length: 32, info: 'rover-session', returnAs: 'base64url' }),
    )
    expect(await tickToken(`${SECRET.slice(0, -1)}r`, false)).not.toBe(token)
  })

  it('under dev, derives from the development seed when the key is empty, and refuses elsewhere', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await tickToken('', true)).toBe(
      await hkdf(DEV_SEED, { length: 32, info: 'rover-tick', returnAs: 'base64url' }),
    )
    expect(() => tickToken('', false)).toThrow(/NUXT_SESSION_KEY/)
    expect(() => tickToken(DEV_SEED, false)).toThrow(/public development seed/)
    expect(() => tickToken('too short', false)).toThrow(/at least 32 characters/)
  })

  it('authorizes only its own bearer', async () => {
    const token = await tickToken(SECRET, false)
    expect(isTickAuthorized(token, `Bearer ${token}`)).toBe(true)
    const otherKey = await tickToken(`${SECRET}x`, false)
    const otherInfo = await hkdf(SECRET, {
      length: 32,
      info: 'rover-session',
      returnAs: 'base64url',
    })
    for (const header of [
      `Bearer ${otherKey}`,
      `Bearer ${otherInfo}`,
      token,
      `Basic ${token}`,
      '',
    ]) {
      expect(isTickAuthorized(token, header)).toBe(false)
    }
    expect(isTickAuthorized(token, null)).toBe(false)
  })
})

describe('the background function', () => {
  function request(body: unknown, authorization?: string): Request {
    return new Request(`https://rover.test${TICK_FUNCTION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('logs a request with a bad token and returns without ticking or throwing', async () => {
    vi.stubEnv('NUXT_SESSION_KEY', SECRET)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrong = await tickToken(`${SECRET}x`, false)
    for (const authorization of [undefined, `Bearer ${wrong}`]) {
      await expect(entry(request({ missionId: 'm1' }, authorization))).resolves.toBe(undefined)
    }
    expect(tickMission).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(2)
    expect(String(logged.mock.calls[0]![0])).toMatch(/bad token/)
  })

  it('logs a request whose body is not { missionId } and returns without throwing', async () => {
    vi.stubEnv('NUXT_SESSION_KEY', SECRET)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bearer = `Bearer ${await tickToken(SECRET, false)}`
    for (const body of ['not json', {}, { missionId: '' }, { missionId: 7 }]) {
      await expect(entry(request(body, bearer))).resolves.toBe(undefined)
    }
    expect(tickMission).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(4)
  })

  it('logs and returns when no session key is set outside dev', async () => {
    vi.stubEnv('NUXT_SESSION_KEY', '')
    // A local production build is not dev.
    vi.stubEnv('NETLIFY_LOCAL', 'true')
    vi.stubEnv('CONTEXT', 'production')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bearer = `Bearer ${await hkdf(DEV_SEED, { length: 32, info: 'rover-tick', returnAs: 'base64url' })}`
    await expect(entry(request({ missionId: 'm1' }, bearer))).resolves.toBe(undefined)
    expect(tickMission).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalled()
  })

  it('ticks the mission with the try-lock and no deadline, and logs what it did', async () => {
    vi.stubEnv('NUXT_SESSION_KEY', SECRET)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await entry(request({ missionId: 'm1' }, `Bearer ${await tickToken(SECRET, false)}`))
    expect(tickMission).toHaveBeenCalledExactlyOnceWith(fakeDb, {
      missionId: 'm1',
      store: expect.anything(),
      jev: expect.anything(),
      now: expect.any(Date),
      lock: 'try',
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[mission] background tick m1'))
    expect(purge).not.toHaveBeenCalled()
  })

  it('accepts the development token under dev with an empty key', async () => {
    vi.stubEnv('NUXT_SESSION_KEY', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('NETLIFY_LOCAL', 'true')
    vi.stubEnv('CONTEXT', 'dev')
    await entry(request({ missionId: 'm1' }, `Bearer ${await tickToken('', true)}`))
    expect(tickMission).toHaveBeenCalledOnce()
  })

  it('purges the cached state after a tick that changed something, and throws when the tick fails', async () => {
    vi.stubEnv('NETLIFY', 'true')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const token = () => Promise.resolve('t')
    const good = () => request({ missionId: 'm1' }, 'Bearer t')
    await runTickRequest(good(), {
      token,
      tick: async () => ({ ...IDLE, opened: { roundId: 'r2' } }),
    })
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['mission-m1'] })
    await expect(
      runTickRequest(good(), { token, tick: () => Promise.reject(new Error('the tick broke')) }),
    ).rejects.toThrow('the tick broke')
  })
})

describe('the tick dispatcher', () => {
  function dispatcherOver(fetch: DispatchFetch) {
    let now = 0
    const dispatch = createTickDispatcher({ token: async () => 'tok', fetch, clock: () => now })
    return { dispatch, advance: (ms: number) => void (now += ms) }
  }

  it("posts { missionId } with the bearer to the background function on the request's origin", async () => {
    const fetch = vi.fn<DispatchFetch>(async () => new Response(null, { status: 202 }))
    const kept: Promise<unknown>[] = []
    vi.stubGlobal('Netlify', { context: { waitUntil: (p: Promise<unknown>) => kept.push(p) } })
    const { dispatch } = dispatcherOver(fetch)
    dispatch('m1', 'https://deploy-preview-7--rover.netlify.app')
    await Promise.all(kept)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://deploy-preview-7--rover.netlify.app/.netlify/functions/mission-tick-background',
      {
        method: 'POST',
        headers: { 'authorization': 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ missionId: 'm1' }),
      },
    )
  })

  it('never waits for the function to answer', async () => {
    let answer!: (response: Response) => void
    const fetch = vi.fn<DispatchFetch>(() => new Promise((resolve) => (answer = resolve)))
    const kept: Promise<unknown>[] = []
    vi.stubGlobal('Netlify', { context: { waitUntil: (p: Promise<unknown>) => kept.push(p) } })
    const { dispatch } = dispatcherOver(fetch)
    expect(dispatch('m1', 'http://localhost:3100')).toBeUndefined()
    expect(kept).toHaveLength(1)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    let settled = false
    void kept[0]!.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    answer(new Response(null, { status: 202 }))
    await kept[0]
  })

  it('dispatches a mission at most once per 30 s, each mission on its own', async () => {
    const fetch = vi.fn<DispatchFetch>(async () => new Response(null, { status: 202 }))
    const { dispatch, advance } = dispatcherOver(fetch)
    const origin = 'https://rover.test'
    dispatch('m1', origin)
    dispatch('m1', origin)
    dispatch('m2', origin)
    advance(29_999)
    dispatch('m1', origin)
    advance(1)
    dispatch('m1', origin)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).missionId)
    expect(bodies).toEqual(['m1', 'm2', 'm1'])
  })

  it('logs a dispatch that fails or is refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kept: Promise<unknown>[] = []
    vi.stubGlobal('Netlify', { context: { waitUntil: (p: Promise<unknown>) => kept.push(p) } })
    const fetch = vi
      .fn<DispatchFetch>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    const { dispatch } = dispatcherOver(fetch)
    dispatch('m1', 'https://rover.test')
    dispatch('m2', 'https://rover.test')
    await Promise.all(kept)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('m1'), expect.any(Error))
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/m2.*404/))
  })
})

describe('isMissionDue', () => {
  it('is due from the recorded next due instant on, and never without one', () => {
    const now = new Date('2030-01-01T00:05:00Z')
    expect(isMissionDue({ nextDueAt: null }, now)).toBe(false)
    expect(isMissionDue({ nextDueAt: new Date(now.getTime() + 1) }, now)).toBe(false)
    expect(isMissionDue({ nextDueAt: now }, now)).toBe(true)
    expect(isMissionDue({ nextDueAt: new Date(now.getTime() - 1) }, now)).toBe(true)
  })
})

describe('purgeMissionCache', () => {
  it('purges the mission tag on Netlify', async () => {
    vi.stubEnv('NETLIFY', 'true')
    await purgeMissionCache('m1')
    expect(purge).toHaveBeenCalledWith({ tags: ['mission-m1'] })
  })

  it('does nothing off Netlify', async () => {
    vi.stubEnv('NETLIFY', '')
    await purgeMissionCache('m1')
    expect(purge).not.toHaveBeenCalled()
  })

  it('logs a failed purge instead of failing the request', async () => {
    vi.stubEnv('NETLIFY', 'true')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    purge.mockRejectedValueOnce(new Error('no purge token'))
    await expect(purgeMissionCache('m1')).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalled()
  })
})
