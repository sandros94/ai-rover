import { revealedKey, stopManifestKey, stopPackKey } from '#shared/utils/terrain'

/**
 * What a first visitor of a published stop fetches before anything else: its manifest, revealed
 * mask and disk pack. Nothing of a segment, so priming never reaches a drive still in progress.
 */
export function stopPrimeKeys(missionId: string, stopIndex: number): string[] {
  return [
    stopManifestKey(missionId, stopIndex),
    revealedKey(missionId, stopIndex),
    stopPackKey(missionId, stopIndex),
  ]
}

/** The part of `fetch` priming uses. */
export type PrimeFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>

/**
 * Requests the stop's {@link stopPrimeKeys} once through the site's public address, so the CDN's
 * durable cache holds them before the first visitor asks. Runs only where the platform sets `URL`
 * (the site's address); failures are logged and ignored. Not awaited by callers: the platform is
 * asked to keep the function alive until it settles, and the promise never rejects.
 */
export function primeStop(
  missionId: string,
  stopIndex: number,
  options: { siteUrl?: string; fetch?: PrimeFetch } = {},
): Promise<void> {
  const siteUrl = options.siteUrl ?? process.env.URL
  if (!siteUrl) return Promise.resolve()
  const fetch: PrimeFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const primed = Promise.all(
    stopPrimeKeys(missionId, stopIndex).map(async (key) => {
      const url = new URL(`/journey/${key}`, siteUrl).href
      try {
        // Browsers ask for compressed bodies, and the cache keeps one copy per encoding asked.
        const response = await fetch(url, {
          headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
        })
        await response.arrayBuffer()
        if (!response.ok) console.error(`[journey] priming ${url} answered ${response.status}`)
      } catch (error) {
        console.error(`[journey] priming ${url} failed:`, error)
      }
    }),
  ).then(() => {})
  globalThis.Netlify?.context?.waitUntil(primed)
  return primed
}
