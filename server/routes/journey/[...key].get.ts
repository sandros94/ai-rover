import { defineHandler, getRouterParam } from 'nitro/h3'
import {
  parseJourneyKey,
  parseStoredSegmentManifest,
  segmentManifestKey,
  sliceGate,
} from '#shared/utils/drive'
import { createJourneyStore } from '../../utils/journey/store'

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Journey blobs through the CDN, deflated as stored and cached forever. A segment slice is
 * refused, uncached, until wall-clock reaches its release time.
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
  return new Response(blob.bytes, {
    headers: {
      'content-type': blob.metadata.contentType,
      'content-encoding': blob.metadata.encoding,
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
