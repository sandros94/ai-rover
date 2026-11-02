import { H3, HTTPError } from 'nitro/h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertLoopback } from '~~/modules/dev/runtime/server/utils/loopback'
import { defineDevWriteHandler } from '~~/modules/dev/runtime/server/utils/write'

const DEV = 'http://localhost:3000'
const LOCAL = 'postgres://postgres@127.0.0.1:5456/postgres'
const REMOTE = 'postgres://user:secret@db.example.com:5432/neondb'

/** An app whose one route counts the writes it was let through and answers with `answer`. */
function appWith(answer: () => unknown) {
  const app = { writes: 0, h3: new H3() }
  app.h3.post(
    '/api/_dev/write',
    defineDevWriteHandler(() => {
      app.writes++
      return answer()
    }),
  )
  return app
}

const post = (app: ReturnType<typeof appWith>, headers: Record<string, string>) =>
  app.h3.request(`${DEV}/api/_dev/write`, { method: 'POST', headers })

beforeEach(() => vi.stubEnv('NETLIFY_DB_URL', LOCAL))
afterEach(() => vi.unstubAllEnvs())

describe('defineDevWriteHandler', () => {
  it('runs the handler for pages of the dev server, named by Origin or by Referer', async () => {
    const app = appWith(() => ({ ok: true }))
    const accepted: Record<string, string>[] = [{ origin: DEV }, { referer: `${DEV}/_dev` }]
    for (const headers of accepted) {
      const answer = await post(app, headers)
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({ ok: true })
    }
    expect(app.writes).toBe(2)
  })

  it('refuses another site or a request naming no origin with 403, writing nothing', async () => {
    const app = appWith(() => ({ ok: true }))
    const refused: Record<string, string>[] = [{ origin: 'https://evil.example' }, {}]
    for (const headers of refused) {
      const answer = await post(app, headers)
      expect(answer.status).toBe(403)
      expect((await answer.json()).message).toBe(
        "POST /api/_dev/write is accepted only from the dev server's own pages.",
      )
    }
    expect(app.writes).toBe(0)
  })

  it('refuses with 403 while NETLIFY_DB_URL is not on this machine, writing nothing', async () => {
    vi.stubEnv('NETLIFY_DB_URL', REMOTE)
    const app = appWith(() => ({ ok: true }))
    const answer = await post(app, { origin: DEV })
    expect(answer.status).toBe(403)
    const { message } = await answer.json()
    expect(message).toMatch(/db\.example\.com:5432.*not on this machine/)
    expect(message).not.toContain('secret')
    expect(app.writes).toBe(0)
  })

  it('answers 403 when the handler finds its own database not on this machine', async () => {
    const app = appWith(() => assertLoopback(REMOTE))
    const answer = await post(app, { origin: DEV })
    expect(answer.status).toBe(403)
    const { message } = await answer.json()
    expect(message).toMatch(/db\.example\.com:5432.*not on this machine/)
    expect(message).not.toContain('secret')
  })

  it('answers any other error the handler throws as is', async () => {
    const app = appWith(() => {
      throw new HTTPError('Already has a mission.', { status: 409 })
    })
    const answer = await post(app, { origin: DEV })
    expect(answer.status).toBe(409)
    expect((await answer.json()).message).toBe('Already has a mission.')
  })
})
