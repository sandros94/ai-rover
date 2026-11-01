import type { BlobStore, JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'

/** In-memory stand-in for a Netlify Blobs store, recording the order of writes. */
export class MemoryBlobs implements BlobStore {
  readonly blobs = new Map<string, { data: ArrayBuffer; metadata: Record<string, unknown> }>()
  readonly writes: string[] = []

  async set(key: string, data: ArrayBuffer, options: { metadata: Record<string, unknown> }) {
    this.writes.push(key)
    this.blobs.set(key, { data: data.slice(0), metadata: structuredClone(options.metadata) })
  }

  async getWithMetadata(key: string, _options: { type: 'arrayBuffer' }) {
    const blob = this.blobs.get(key)
    return blob ? { data: blob.data.slice(0), metadata: structuredClone(blob.metadata) } : null
  }

  async getMetadata(key: string) {
    const blob = this.blobs.get(key)
    return blob ? { metadata: structuredClone(blob.metadata) } : null
  }

  async list(options: { prefix?: string } = {}) {
    const prefix = options.prefix ?? ''
    return {
      blobs: [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }
  }

  async delete(key: string) {
    this.blobs.delete(key)
  }
}

/** Resolves once every microtask queued so far, and each one those queue, has run. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * A journey store over {@link MemoryBlobs} whose `putImmutable` calls are held until released,
 * counting how many overlap at most. A write is held as it is called, before it deflates
 * anything, so a writer waiting only on the store has started all it will once the microtasks
 * queued so far have run. No clock is involved: the test decides when each write runs (see
 * {@link drive}).
 */
export class CountingStore {
  readonly blobs = new MemoryBlobs()
  readonly store: JourneyStore
  inFlight = 0
  maxInFlight = 0
  /** The writes held, oldest first; each runs once released, and `done` settles with it. */
  private readonly held: { release: () => void; done: Promise<unknown> }[] = []

  constructor() {
    const inner = createJourneyStore({ store: this.blobs })
    this.store = {
      ...inner,
      putImmutable: (...args) => {
        this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight)
        const { promise, resolve } = Promise.withResolvers<void>()
        const done = promise.then(() => inner.putImmutable(...args)).finally(() => this.inFlight--)
        this.held.push({ release: resolve, done })
        return done
      },
    }
  }

  /**
   * Runs `work` to its end, letting it start every write it will before releasing the oldest
   * held one, then waiting for that write to finish, one write at a time. A writer bounded to
   * `n` writes in flight so keeps exactly `n` held whenever it has that many to write. Returns
   * what `work` resolves to; throws instead of hanging when `work` stays pending with no write
   * held.
   */
  async drive<T>(work: Promise<T>): Promise<T> {
    let done = false
    const finished = work.finally(() => {
      done = true
    })
    finished.catch(() => {})
    while (true) {
      await settled()
      if (done) break
      const next = this.held.shift()
      if (!next) throw new Error('The work is still pending with no write held.')
      next.release()
      await next.done.catch(() => {})
    }
    return finished
  }
}
