import type { BlobStore } from '#server/utils/journey/store'

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

/** Event-loop turns {@link CountingBlobs.drive} waits for writes to arrive before it gives up. */
const IDLE_TURNS = 1000

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * {@link MemoryBlobs} whose writes are held until released, counting how many overlap at most.
 * No clock is involved: the test decides when each write completes (see {@link drive}).
 */
export class CountingBlobs extends MemoryBlobs {
  inFlight = 0
  maxInFlight = 0
  /** Resolvers of the writes held, oldest first. */
  private readonly held: (() => void)[] = []

  override async set(
    key: string,
    data: ArrayBuffer,
    options: { metadata: Record<string, unknown> },
  ) {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight)
    try {
      await new Promise<void>((resolve) => this.held.push(resolve))
      await super.set(key, data, options)
    } finally {
      this.inFlight--
    }
  }

  /**
   * Runs `work` to its end, completing the held writes one at a time, oldest first, each only
   * once the writer has started all it will: `bound` of them, or, when fewer are left, those it
   * starts before the event loop has turned {@link IDLE_TURNS} times with no new one (deflating
   * a blob takes a few turns). A writer that keeps to `bound` then reaches it exactly whenever it
   * has that many to write. Returns what `work` resolves to; throws instead of hanging when
   * `work` stays pending with no write held.
   */
  async drive<T>(work: Promise<T>, bound: number): Promise<T> {
    let done = false
    const finished = work.finally(() => {
      done = true
    })
    finished.catch(() => {})
    while (!done) {
      let quiet = 0
      let count = this.held.length
      while (!done && this.held.length < bound && quiet < IDLE_TURNS) {
        await nextTurn()
        quiet = this.held.length === count ? quiet + 1 : 0
        count = this.held.length
      }
      if (done) break
      if (!this.held.length) {
        throw new Error(`No write arrived in ${IDLE_TURNS} turns and the work is still pending.`)
      }
      this.held.shift()!()
    }
    return finished
  }
}
