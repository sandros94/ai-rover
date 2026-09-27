import type { SegmentSlice, StoredSegmentManifest } from '../drive/slices'
import { decodeSlice, parseStoredSegmentManifest } from '../drive/slices'
import { segmentManifestKey, segmentSliceKey } from '../drive/keys'
import type { Chunk } from '../terrain/chunk'
import { decodeChunk } from '../terrain/encode'
import type { StopManifest } from '../terrain/manifest'
import {
  chunkKey,
  parseStopManifest,
  revealedKey,
  stopManifestKey,
  stopPackKey,
} from '../terrain/manifest'
import { readDiskPack } from '../terrain/pack'
import { TerrainError } from '../terrain/errors'
import type { RevealedMask } from '../terrain/revealed'
import { decodeRevealedMask } from '../terrain/revealed'
import { ClientError } from './errors'

/** The part of `fetch` the client uses: a URL in, a `Response` out. */
export type FetchLike = (input: string) => Promise<Response>

/** A slice as the server answers for it. Closed set. */
export type SliceResult =
  | { status: 'ready'; slice: SegmentSlice }
  /** Not released yet; `releaseAt` is the server's release time, epoch milliseconds. */
  | { status: 'not-yet'; releaseAt: number }
  /** No such slice: past the segment's end, or an unknown segment. */
  | { status: 'missing' }

export interface JourneyClient {
  getStopManifest(missionId: string, stopIndex: number): Promise<StopManifest>
  getRevealedMask(missionId: string, stopIndex: number): Promise<RevealedMask>
  getChunk(worldHash: string, cx: number, cy: number): Promise<Chunk>
  /**
   * The stop's disk pack as a stream of chunks, decoded as the bytes arrive; null when the stop
   * has no pack, as stops published before packs existed. Breaking off the iteration cancels the
   * download.
   */
  getStopPack(missionId: string, stopIndex: number): Promise<AsyncIterable<Chunk> | null>
  getSegmentManifest(segmentId: string): Promise<StoredSegmentManifest>
  getSlice(segmentId: string, sliceIndex: number): Promise<SliceResult>
}

/**
 * Reads journey blobs from `{baseUrl}/{key}` and decodes them with the shared decoders. The
 * blobs travel with `content-encoding: deflate`, which `fetch` inflates on its own; a `fetch`
 * handed in must do the same, or serve inflated bytes.
 */
export function createJourneyClient(
  options: { fetch?: FetchLike; baseUrl?: string } = {},
): JourneyClient {
  const { fetch = (input: string) => globalThis.fetch(input), baseUrl = '/journey' } = options
  const base = baseUrl.replace(/\/+$/, '')

  async function request(key: string): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${base}/${key}`)
    } catch (error) {
      throw new ClientError(
        'NETWORK',
        `Journey request for "${key}" failed; check the connection and retry.`,
        { cause: error },
      )
    }
    if (response.ok || response.status === 404) return response
    throw new ClientError(
      'NETWORK',
      `Journey request for "${key}" answered ${response.status}; retry later.`,
    )
  }

  async function bytesOf(key: string, response: Response): Promise<Uint8Array> {
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw new ClientError('NETWORK', `Journey response for "${key}" broke off; retry.`, {
        cause: error,
      })
    }
  }

  /** The blob's bytes; NOT_FOUND on a 404, since `what` must exist once its key is known. */
  async function required(key: string, what: string): Promise<Uint8Array> {
    const response = await request(key)
    if (response.status === 404) {
      throw new ClientError('NOT_FOUND', `${what} "${key}" does not exist; check the id and index.`)
    }
    return bytesOf(key, response)
  }

  function decode<T>(
    key: string,
    what: string,
    bytes: Uint8Array,
    decoder: (bytes: Uint8Array) => T,
  ): T {
    try {
      return decoder(bytes)
    } catch (error) {
      throw new ClientError(
        'DECODE',
        `${what} "${key}" did not decode: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  const json = (bytes: Uint8Array): unknown =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

  return {
    async getStopManifest(missionId, stopIndex) {
      const key = stopManifestKey(missionId, stopIndex)
      const bytes = await required(key, 'Stop manifest')
      return decode(key, 'Stop manifest', bytes, (b) => parseStopManifest(json(b)))
    },

    async getRevealedMask(missionId, stopIndex) {
      const key = revealedKey(missionId, stopIndex)
      return decode(key, 'Revealed mask', await required(key, 'Revealed mask'), decodeRevealedMask)
    },

    async getChunk(worldHash, cx, cy) {
      const key = chunkKey(worldHash, { cx, cy })
      const chunk = decode(key, 'Chunk', await required(key, 'Chunk'), decodeChunk)
      if (chunk.cx !== cx || chunk.cy !== cy) {
        throw new ClientError(
          'DECODE',
          `Chunk "${key}" holds chunk (${chunk.cx}, ${chunk.cy}); the store is inconsistent.`,
        )
      }
      return chunk
    },

    async getStopPack(missionId, stopIndex) {
      const key = stopPackKey(missionId, stopIndex)
      const response = await request(key)
      if (response.status === 404) return null
      // A body-less answer reads as an empty pack, which the decoder refuses as truncated.
      const body = response.body ?? new Blob([]).stream()
      return (async function* () {
        try {
          yield* readDiskPack(body.getReader())
        } catch (error) {
          if (error instanceof TerrainError) {
            throw new ClientError('DECODE', `Disk pack "${key}" did not decode: ${error.message}`, {
              cause: error,
            })
          }
          throw new ClientError('NETWORK', `Journey response for "${key}" broke off; retry.`, {
            cause: error,
          })
        }
      })()
    },

    async getSegmentManifest(segmentId) {
      const key = segmentManifestKey(segmentId)
      const bytes = await required(key, 'Segment manifest')
      const manifest = decode(key, 'Segment manifest', bytes, (b) =>
        parseStoredSegmentManifest(json(b)),
      )
      if (manifest.segmentId !== segmentId) {
        throw new ClientError(
          'DECODE',
          `Segment manifest "${key}" names segment "${manifest.segmentId}"; the store is inconsistent.`,
        )
      }
      return manifest
    },

    async getSlice(segmentId, sliceIndex) {
      const key = segmentSliceKey(segmentId, sliceIndex)
      const response = await request(key)
      if (response.status === 404) {
        const header = response.headers.get('x-release-at')
        if (header === null) return { status: 'missing' }
        const releaseAt = Date.parse(header)
        if (!Number.isFinite(releaseAt)) {
          throw new ClientError(
            'DECODE',
            `Slice "${key}" is not released, but its x-release-at "${header}" is not a date.`,
          )
        }
        return { status: 'not-yet', releaseAt }
      }
      const slice = decode(key, 'Slice', await bytesOf(key, response), decodeSlice)
      if (slice.index !== sliceIndex) {
        throw new ClientError(
          'DECODE',
          `Slice "${key}" holds slice ${slice.index}; the store is inconsistent.`,
        )
      }
      return { status: 'ready', slice }
    },
  }
}
