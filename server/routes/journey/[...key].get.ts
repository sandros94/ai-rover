import { defineHandler, getRouterParam } from 'nitro/h3'
import {
  parseJourneyKey,
  parseStoredSegmentManifest,
  segmentManifestKey,
  sliceGate,
} from '#shared/utils/drive'
import { acceptsDeflate } from '../../utils/journey/encoding'
import { createJourneyStore } from '../../utils/journey/store'

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Journey blobs through the CDN, deflated as stored and cached forever; a client that does not
 * accept deflate gets them inflated, cached as its own variant. A segment slice is refused,
 * uncached, until wall-clock passes the end of its window (see `sliceReleaseAt`).
 */
export default defineHandler(async (event) => {
  const key = getRouterParam(event, 'key') ?? ''
  const parsed = parseJourneyKey(key)
  if (!parsed) return notFound()

  const store = createJourneyStore()
  if (parsed.kind === 'segment-slice') {
    const manifest = await store.getJson(segmentManifestKey(parsed.segmentId))
    if (manifest === null) return notFound()
    const gate = sliceGate(parseStoredSegmentManifest(manifest), parsed.index, Date.now())
    if (!gate.released) {
      return notFound({ 'x-release-at': new Date(gate.releaseAt).toISOString() })
    }
  }

  const blob = await store.get(key)
  if (!blob) return notFound()
  const deflated = acceptsDeflate(event.req.headers.get('accept-encoding'))
  const body = deflated
    ? blob.bytes
    : new Blob([blob.bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Response(body, {
    headers: {
      'content-type': blob.metadata.contentType,
      ...(deflated && { 'content-encoding': blob.metadata.encoding }),
      'vary': 'accept-encoding',
      'cache-control': IMMUTABLE,
      'netlify-cdn-cache-control': `${IMMUTABLE}, durable`,
      'netlify-cache-tag': 'journey',
    },
  })
})

/** Never cached: a missing blob or an unreleased slice may exist later. */
function notFound(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store', ...headers },
  })
}
