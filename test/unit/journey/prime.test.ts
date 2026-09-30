import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrimeFetch } from '#server/utils/journey/prime'
import { primeStop, stopPrimeKeys } from '#server/utils/journey/prime'

const MISSION = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const KEYS = {
  manifestKey: `missions/${MISSION}/stops/landing.0123456789abcdef.json`,
  revealedKey: `missions/${MISSION}/revealed/landing.0123456789abcdef.bin`,
  packKey: `missions/${MISSION}/stops/landing.pack`,
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('stopPrimeKeys', () => {
  it('names the stop manifest, its revealed mask and its pack, nothing of a segment', () => {
    expect(stopPrimeKeys(KEYS)).toEqual([KEYS.manifestKey, KEYS.revealedKey, KEYS.packKey])
  })
})

describe('primeStop', () => {
  it('requests nothing without the site address', async () => {
    vi.stubEnv('URL', '')
    const fetch = vi.fn<PrimeFetch>(async () => new Response(null))
    await primeStop(KEYS, { fetch })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requests each key once through the public journey route, asking for compression', async () => {
    vi.stubEnv('URL', 'https://rover.example')
    const fetch = vi.fn<PrimeFetch>(async () => new Response('bytes'))
    await primeStop(KEYS, { fetch })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      stopPrimeKeys(KEYS).map((key) => `https://rover.example/journey/${key}`),
    )
    expect(fetch.mock.calls[0]![1].headers['accept-encoding']).toContain('deflate')
  })

  it('logs failures and resolves anyway', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    const fetch = async () => {
      if (n++ === 0) throw new Error('offline')
      return new Response(null, { status: 502 })
    }
    await expect(
      primeStop(KEYS, { siteUrl: 'https://rover.example', fetch }),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(3)
  })
})
