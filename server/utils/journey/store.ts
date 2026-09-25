import { getStore } from '@netlify/blobs'
import * as v from 'valibot'

/** Blob store name holding the journey: terrain chunks, masks, stop and segment data. */
export const JOURNEY_STORE_NAME = 'journey'

/** The subset of a Netlify Blobs `Store` the journey store uses. */
export interface BlobStore {
  set(
    key: string,
    data: ArrayBuffer,
    options: { metadata: Record<string, unknown> },
  ): Promise<unknown>
  getWithMetadata(
    key: string,
    options: { type: 'arrayBuffer' },
  ): Promise<{ data: ArrayBuffer; metadata: Record<string, unknown> } | null>
  getMetadata(key: string): Promise<{ metadata: Record<string, unknown> } | null>
}

const MetadataSchema = v.object({
  contentType: v.pipe(v.string(), v.minLength(1)),
  encoding: v.literal('deflate'),
  rawLength: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
})

/** Stored with every journey blob; the bytes are zlib-wrapped deflate (HTTP `deflate`). */
export type JourneyBlobMetadata = v.InferOutput<typeof MetadataSchema>

export interface PutResult {
  key: string
  rawLength: number
  /** Deflated bytes as stored. */
  storedLength: number
}

export interface JourneyStore {
  /** Deflates `bytes` and stores them under `key`, replacing whatever was there. */
  putImmutable(key: string, bytes: Uint8Array, options: { contentType: string }): Promise<PutResult>
  /** `putImmutable` of the value's JSON as `application/json`. */
  putJson(key: string, value: unknown): Promise<PutResult>
  has(key: string): Promise<boolean>
  /** The stored bytes, still deflated, ready to send with `content-encoding: deflate`. */
  get(
    key: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; metadata: JourneyBlobMetadata } | null>
  getInflated(key: string): Promise<Uint8Array<ArrayBuffer> | null>
  getJson(key: string): Promise<unknown>
}

/**
 * Journey blobs, written deflated and immutable. Defaults to the strongly consistent Netlify
 * Blobs store named {@link JOURNEY_STORE_NAME}, so a reader sees a blob as soon as it is written.
 */
export function createJourneyStore(options: { store?: BlobStore } = {}): JourneyStore {
  const blobs = options.store ?? getStore({ name: JOURNEY_STORE_NAME, consistency: 'strong' })

  async function putImmutable(
    key: string,
    bytes: Uint8Array,
    { contentType }: { contentType: string },
  ): Promise<PutResult> {
    const deflated = await pipe(bytes, new CompressionStream('deflate'))
    const metadata: JourneyBlobMetadata = {
      contentType,
      encoding: 'deflate',
      rawLength: bytes.byteLength,
    }
    await blobs.set(key, deflated.buffer, { metadata })
    return { key, rawLength: bytes.byteLength, storedLength: deflated.byteLength }
  }

  async function get(key: string) {
    const blob = await blobs.getWithMetadata(key, { type: 'arrayBuffer' })
    if (!blob) return null
    const metadata = v.safeParse(MetadataSchema, blob.metadata)
    if (!metadata.success) {
      throw new Error(
        `Journey blob "${key}" has metadata ${JSON.stringify(blob.metadata)}, not the { contentType, encoding: "deflate", rawLength } putImmutable writes; rewrite it through the journey store.`,
        { cause: new v.ValiError(metadata.issues) },
      )
    }
    return { bytes: new Uint8Array(blob.data), metadata: metadata.output }
  }

  async function getInflated(key: string) {
    const blob = await get(key)
    return blob && pipe(blob.bytes, new DecompressionStream('deflate'))
  }

  return {
    putImmutable,
    putJson: (key, value) =>
      putImmutable(key, new TextEncoder().encode(JSON.stringify(value)), {
        contentType: 'application/json',
      }),
    has: async (key) => (await blobs.getMetadata(key)) !== null,
    get,
    getInflated,
    getJson: async (key) => {
      const bytes = await getInflated(key)
      return bytes && JSON.parse(new TextDecoder().decode(bytes))
    },
  }
}

async function pipe(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer())
}
