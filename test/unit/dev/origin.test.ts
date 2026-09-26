import { describe, expect, it } from 'vitest'
import { isSameOrigin } from '~~/modules/dev/runtime/server/utils/origin'

const request = (host: string, headers: Record<string, string>) =>
  new Request(`http://${host}/__jev/db/reset`, { method: 'POST', headers })

describe('isSameOrigin', () => {
  it('accepts an Origin, or a Referer when no Origin is sent, on the dev server itself', () => {
    expect(isSameOrigin(request('localhost:3000', { origin: 'http://localhost:3000' }))).toBe(true)
    // Served with --host: the address a phone on the network reached it by.
    expect(isSameOrigin(request('192.168.1.20:3000', { origin: 'http://192.168.1.20:3000' }))).toBe(
      true,
    )
    expect(
      isSameOrigin(
        request('localhost:3000', { referer: 'http://localhost:3000/__nuxt_devtools__/client/' }),
      ),
    ).toBe(true)
  })

  it('refuses another site, another port, a missing header or a malformed one', () => {
    const refused: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'http://localhost:3001' },
      { origin: 'null' },
      { referer: 'https://evil.example/localhost:3000' },
      // A present Origin decides, whatever the Referer says.
      { origin: 'https://evil.example', referer: 'http://localhost:3000/' },
      {},
    ]
    expect(refused.filter((headers) => isSameOrigin(request('localhost:3000', headers)))).toEqual(
      [],
    )
  })
})
