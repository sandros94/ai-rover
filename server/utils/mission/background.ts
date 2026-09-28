import { purgeCache } from '@netlify/functions'
import { secureCompare } from 'unsecure/compare'
import * as v from 'valibot'
import { deriveSecret, sessionSecret } from '../../../modules/auth/runtime/server/lib/key'
import type { Mission } from '../../database/schema'
import type { TickResult } from './tick'

// Imported by the background function, which runs outside Nitro: nothing here may import `nitro/*`.

/** Where the background function answers, on the site's own origin. */
export const TICK_FUNCTION_PATH = '/.netlify/functions/mission-tick-background'

/** Shortest interval between two dispatches of one mission's tick from one server instance. */
export const DISPATCH_INTERVAL_MS = 30_000

/** Whether a tick has something to do at `now`, from the recorded next due instant alone. */
export function isMissionDue(mission: Pick<Mission, 'nextDueAt'>, now: Date): boolean {
  return mission.nextDueAt !== null && mission.nextDueAt.getTime() <= now.getTime()
}

/** Whether a tick changed anything the public state shows. */
export function tickChanged(tick: TickResult): boolean {
  const { settled, closed, started, opened } = tick
  return [settled, closed, started, opened].some((step) => step !== null)
}

/**
 * Drops the CDN's copies of the mission's public state. Only Netlify has that cache; a failed
 * purge is logged and leaves the copies to expire within their short lifetime.
 */
export async function purgeMissionCache(missionId: string): Promise<void> {
  if (!process.env.NETLIFY) return
  try {
    await purgeCache({ tags: [`mission-${missionId}`] })
  } catch (error) {
    console.error(`[mission] purging the cache of mission ${missionId} failed:`, error)
  }
}

/**
 * The bearer a dispatcher sends and the background function expects: HKDF of `NUXT_SESSION_KEY`
 * (as given, `sessionKey` rules; under `nuxt dev` an empty key is the development seed) under its
 * own info, so it opens nothing a session key opens. Throws on a key `sessionKey` refuses.
 */
export function tickToken(sessionKey: string, dev: boolean): Promise<string> {
  return deriveSecret(sessionSecret(sessionKey, dev), 'rover-tick')
}

/** Whether `authorization` carries `expected` as its bearer, compared in constant time. */
export function isTickAuthorized(expected: string, authorization: string | null): boolean {
  const bearer = authorization?.match(/^Bearer (\S+)$/)?.[1]
  return secureCompare(expected, bearer)
}

/** The part of `fetch` a dispatcher uses. */
export type DispatchFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<Response>

/** Asks the background function on `origin` to tick `missionId`; returns at once. */
export type TickDispatcher = (missionId: string, origin: string) => void

/**
 * A {@link TickDispatcher} that POSTs `{ missionId }` with the {@link tickToken} bearer, at most
 * once per mission per `intervalMs` (default {@link DISPATCH_INTERVAL_MS}): every read of a due
 * mission would otherwise start one, and the try-lock only makes the overlap harmless. The
 * request is never awaited: the platform is asked to keep the function alive until it settles,
 * and its failure is logged.
 */
export function createTickDispatcher(options: {
  token: () => Promise<string>
  fetch?: DispatchFetch
  clock?: () => number
  intervalMs?: number
}): TickDispatcher {
  const { token, clock = Date.now, intervalMs = DISPATCH_INTERVAL_MS } = options
  const fetch: DispatchFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const last = new Map<string, number>()
  return (missionId, origin) => {
    const now = clock()
    const previous = last.get(missionId)
    if (previous !== undefined && now - previous < intervalMs) return
    last.set(missionId, now)
    const url = new URL(TICK_FUNCTION_PATH, origin).href
    const sent = (async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${await token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ missionId }),
      })
      await response.body?.cancel()
      if (!response.ok) {
        console.error(
          `[mission] dispatching the tick of mission ${missionId} answered ${response.status}`,
        )
      }
    })().catch((error: unknown) => {
      console.error(`[mission] dispatching the tick of mission ${missionId} failed:`, error)
    })
    globalThis.Netlify?.context?.waitUntil(sent)
  }
}

const TickRequestSchema = v.object({ missionId: v.pipe(v.string(), v.minLength(1)) })

/**
 * The background function's work: checks the bearer against `token`, reads `{ missionId }`, runs
 * `tick` and purges the cached public state when it changed anything. A refused request is
 * logged and returns: the platform retries a background function that throws, which only a
 * failing tick should earn.
 */
export async function runTickRequest(
  request: Request,
  options: { token: () => Promise<string>; tick: (missionId: string) => Promise<TickResult> },
): Promise<void> {
  let expected: string
  try {
    expected = await options.token()
  } catch (error) {
    console.error('[mission] background tick refused: no tick token:', error)
    return
  }
  if (!isTickAuthorized(expected, request.headers.get('authorization'))) {
    console.error('[mission] background tick refused: bad token')
    return
  }
  const body = v.safeParse(TickRequestSchema, await request.json().catch(() => undefined))
  if (!body.success) {
    console.error('[mission] background tick refused: the body is not { missionId }')
    return
  }
  const { missionId } = body.output
  const tick = await options.tick(missionId)
  console.log(`[mission] background tick ${missionId}: ${JSON.stringify(tick)}`)
  if (tickChanged(tick)) await purgeMissionCache(missionId)
}
