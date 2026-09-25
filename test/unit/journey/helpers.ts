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
}
