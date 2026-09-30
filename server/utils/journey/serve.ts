import {
  encodeTraceBlock,
  parseJourneyKey,
  parseStoredSegmentManifest,
  segmentManifestKey,
  segmentTraceKey,
  sliceGate,
} from '#shared/utils/drive'
import { IMMUTABLE_CACHE } from '#shared/utils/cache'
import { acceptsDeflate } from './encoding'
import type { JourneyStore } from './store'

const BINARY = 'application/octet-stream'

/**
 * The response to `/journey/{key}`: journey blobs through the CDN, deflated as stored and cached
 * forever; a client that does not accept deflate gets them inflated, cached as its own variant. A
 * segment slice and its trace are refused, uncached, until wall-clock `now` passes the end of the
 * slice's window since the segment's start, the one `startOf` gives (see `sliceReleaseAt`); a
 * trace block until its last trace is released, and it is then assembled from the stored traces,
 * never stored itself. A segment without a start (no row names it) serves none of them.
 */
export async function serveJourney(
  store: JourneyStore,
  key: string,
  options: {
    now: number
    acceptEncoding: string | null
    /** The segment's start, epoch milliseconds, as its row states it; null for none. */
    startOf: (segmentId: string) => Promise<number | null>
  },
): Promise<Response> {
  const parsed = parseJourneyKey(key)
  if (!parsed) return notFound()
  if (
    parsed.kind === 'segment-slice' ||
    parsed.kind === 'segment-trace' ||
    parsed.kind === 'segment-trace-block'
  ) {
    const startedAt = await options.startOf(parsed.segmentId)
    if (startedAt === null) return notFound()
    const manifest = await store.getJson(segmentManifestKey(parsed.segmentId))
    if (manifest === null) return notFound()
    const { sliceSeconds } = parseStoredSegmentManifest(manifest)
    const last = parsed.kind === 'segment-trace-block' ? parsed.to : parsed.index
    const gate = sliceGate({ startedAt, sliceSeconds }, last, options.now)
    if (!gate.released) {
      return notFound({ 'x-release-at': new Date(gate.releaseAt).toISOString() })
    }
  }
  const deflated = acceptsDeflate(options.acceptEncoding)

  if (parsed.kind === 'segment-trace-block') {
    const traces = await Promise.all(
      Array.from({ length: parsed.to - parsed.from + 1 }, (_, k) =>
        store.getInflated(segmentTraceKey(parsed.segmentId, parsed.from + k)),
      ),
    )
    // A released block past the drive's end holds traces that do not exist.
    if (traces.some((trace) => trace === null)) return notFound()
    const bytes = encodeTraceBlock(traces as Uint8Array[])
    const source = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
    return found(deflated ? source.pipeThrough(new CompressionStream('deflate')) : source, {
      contentType: BINARY,
      deflated,
    })
  }

  const blob = await store.get(key)
  if (!blob) return notFound()
  const body = deflated
    ? blob.bytes
    : new Blob([blob.bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return found(body, { contentType: blob.metadata.contentType, deflated })
}

function found(body: BodyInit, options: { contentType: string; deflated: boolean }): Response {
  return new Response(body, {
    headers: {
      'content-type': options.contentType,
      ...(options.deflated && { 'content-encoding': 'deflate' }),
      'vary': 'accept-encoding',
      'cache-control': IMMUTABLE_CACHE,
      'netlify-cdn-cache-control': `${IMMUTABLE_CACHE}, durable`,
      'netlify-cache-tag': 'journey',
    },
  })
}

/** Never cached: a missing blob or an unreleased slice may exist later. */
function notFound(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store', ...headers },
  })
}
