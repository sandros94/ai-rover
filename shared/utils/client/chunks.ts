import type { Chunk, ChunkCoords } from '../terrain/chunk'
import type { StopManifest } from '../terrain/manifest'
import { ClientError } from './errors'
import type { JourneyClient } from './journey'

/** Chunks a cache keeps when none is given: a 500 m stop disk lists 224. */
export const DEFAULT_CHUNK_CACHE_SIZE = 300

/** Chunk requests {@link ChunkCache.prefetch} keeps open when none is given. */
export const DEFAULT_PREFETCH_CONCURRENCY = 6

/** Vertex layout shared by every chunk of a world. */
export interface ChunkGeometry {
  vertexCount: number
  cellSize: number
}

export interface ChunkCache {
  readonly worldHash: string
  /** Decoded chunks held. */
  readonly size: number
  /** Learnt from the first chunk loaded; every later chunk must match it. */
  readonly geometry: ChunkGeometry | undefined
  /** The chunk, loaded once however many callers ask at the same time. */
  get(cx: number, cy: number): Promise<Chunk>
  /**
   * The chunk if it is held, without loading it. Does not count as a use for eviction, so
   * per-frame sampling stays cheap; what is wanted is decided by `get` and `prefetch`.
   */
  peek(cx: number, cy: number): Chunk | undefined
  /**
   * Loads the chunks in the given order, at most `concurrency` at a time, calling `onChunk` as
   * each arrives. Every chunk is attempted; the first failure rejects once all have settled.
   */
  prefetch(
    coords: readonly ChunkCoords[],
    options?: { concurrency?: number; onChunk?: (chunk: Chunk) => void },
  ): Promise<void>
}

/** Decoded chunks of one world, least recently used evicted past `max`. */
export function createChunkCache(options: {
  client: JourneyClient
  worldHash: string
  max?: number
}): ChunkCache {
  const { client, worldHash, max = DEFAULT_CHUNK_CACHE_SIZE } = options
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new ClientError('INVALID_INPUT', `Chunk cache size is ${max}; pass a positive integer.`)
  }
  // Map order is recency order: the first entry is the least recently used.
  const held = new Map<string, Chunk>()
  const loading = new Map<string, Promise<Chunk>>()
  let geometry: ChunkGeometry | undefined

  function hold(key: string, chunk: Chunk): void {
    held.delete(key)
    held.set(key, chunk)
    while (held.size > max) held.delete(held.keys().next().value!)
  }

  function accept(chunk: Chunk): void {
    const { vertexCount, cellSize } = chunk
    if (!geometry) {
      geometry = { vertexCount, cellSize }
      return
    }
    if (vertexCount !== geometry.vertexCount || cellSize !== geometry.cellSize) {
      throw new ClientError(
        'DECODE',
        `Chunk (${chunk.cx}, ${chunk.cy}) has ${vertexCount} vertices at ${cellSize} m; world ${worldHash} chunks have ${geometry.vertexCount} at ${geometry.cellSize} m.`,
      )
    }
  }

  function get(cx: number, cy: number): Promise<Chunk> {
    const key = `${cx},${cy}`
    const chunk = held.get(key)
    if (chunk) {
      hold(key, chunk)
      return Promise.resolve(chunk)
    }
    let pending = loading.get(key)
    if (!pending) {
      pending = client
        .getChunk(worldHash, cx, cy)
        .then((loaded) => {
          accept(loaded)
          hold(key, loaded)
          return loaded
        })
        .finally(() => loading.delete(key))
      loading.set(key, pending)
    }
    return pending
  }

  async function prefetch(
    coords: readonly ChunkCoords[],
    prefetchOptions: { concurrency?: number; onChunk?: (chunk: Chunk) => void } = {},
  ): Promise<void> {
    const { concurrency = DEFAULT_PREFETCH_CONCURRENCY, onChunk } = prefetchOptions
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new ClientError(
        'INVALID_INPUT',
        `Prefetch concurrency is ${concurrency}; pass a positive integer.`,
      )
    }
    let next = 0
    let failure: { error: unknown } | undefined
    async function worker(): Promise<void> {
      while (next < coords.length) {
        const { cx, cy } = coords[next++]!
        try {
          const chunk = await get(cx, cy)
          onChunk?.(chunk)
        } catch (error) {
          failure ??= { error }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, coords.length) }, worker))
    if (failure) throw failure.error
  }

  return {
    worldHash,
    get size() {
      return held.size
    },
    get geometry() {
      return geometry
    },
    get,
    peek: (cx, cy) => held.get(`${cx},${cy}`),
    prefetch,
  }
}

/**
 * The manifest's chunks in loading order: those meeting the viewport square first, nearest its
 * centre first; then those meeting the pick ring (the annulus `minM`–`maxM` around `center`);
 * then the rest. Both later groups run nearest `center` first, measured to chunk centres, ties
 * by (cy, cx).
 */
export function loadOrder(
  manifest: Pick<StopManifest, 'chunks'> & { world: Pick<StopManifest['world'], 'chunkSize'> },
  options: {
    center: { x: number; y: number }
    ring: { minM: number; maxM: number }
    viewport?: { x: number; y: number; halfSizeM: number }
  },
): ChunkCoords[] {
  const { chunkSize: size } = manifest.world
  const { center, ring, viewport } = options
  const finite = (...values: number[]) => values.every(Number.isFinite)
  if (!finite(size) || size <= 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `loadOrder: manifest world.chunkSize is ${size}; pass positive metres.`,
    )
  }
  if (!finite(center.x, center.y, ring.minM, ring.maxM) || ring.minM < 0 || ring.maxM < ring.minM) {
    throw new ClientError(
      'INVALID_INPUT',
      `loadOrder: center (${center.x}, ${center.y}) with ring ${ring.minM}–${ring.maxM} m; pass finite metres with 0 ≤ minM ≤ maxM.`,
    )
  }
  if (viewport && (!finite(viewport.x, viewport.y, viewport.halfSizeM) || viewport.halfSizeM < 0)) {
    throw new ClientError(
      'INVALID_INPUT',
      `loadOrder: viewport (${viewport.x}, ${viewport.y}) ± ${viewport.halfSizeM} m; pass finite metres and a non-negative half size.`,
    )
  }

  const ranked = manifest.chunks.map(({ cx, cy }) => {
    const x0 = cx * size
    const y0 = cy * size
    const x1 = x0 + size
    const y1 = y0 + size
    const near = Math.hypot(gap(center.x, x0, x1), gap(center.y, y0, y1))
    const far = Math.hypot(
      Math.max(center.x - x0, x1 - center.x),
      Math.max(center.y - y0, y1 - center.y),
    )
    const inView =
      viewport !== undefined &&
      gap(viewport.x, x0, x1) <= viewport.halfSizeM &&
      gap(viewport.y, y0, y1) <= viewport.halfSizeM
    const inRing = near <= ring.maxM && far >= ring.minM
    const from = inView ? viewport : center
    return {
      cx,
      cy,
      tier: inView ? 0 : inRing ? 1 : 2,
      distance: Math.hypot(x0 + size / 2 - from.x, y0 + size / 2 - from.y),
    }
  })
  ranked.sort((p, q) => p.tier - q.tier || p.distance - q.distance || p.cy - q.cy || p.cx - q.cx)
  return ranked.map(({ cx, cy }) => ({ cx, cy }))
}

/** Distance from `value` to the closed interval [lo, hi]. */
function gap(value: number, lo: number, hi: number): number {
  if (value < lo) return lo - value
  if (value > hi) return value - hi
  return 0
}
