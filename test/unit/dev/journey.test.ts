import { describe, expect, it } from 'vitest'
import { createJourneyStore } from '#server/utils/journey/store'
import { clearLocalJourney } from '~~/modules/dev/runtime/server/utils/journey'
import { RemoteDatabaseError } from '~~/modules/dev/runtime/server/utils/loopback'
import { MemoryBlobs } from '../journey/helpers'

const LOCAL = 'postgres://postgres@127.0.0.1:5456/postgres'

function storeWith(...keys: string[]): MemoryBlobs {
  const blobs = new MemoryBlobs()
  for (const key of keys) blobs.blobs.set(key, { data: new ArrayBuffer(1), metadata: {} })
  return blobs
}

describe('clearLocalJourney', () => {
  it('deletes every key and says how many', async () => {
    const blobs = storeWith('m/1/manifest', 'm/1/stop/0/revealed', 'm/2/manifest')
    expect(await clearLocalJourney(LOCAL, createJourneyStore({ store: blobs }))).toEqual({
      deleted: 3,
    })
    expect([...blobs.blobs.keys()]).toEqual([])
  })

  it('deletes nothing while the database is not on this machine', async () => {
    const blobs = storeWith('m/1/manifest')
    await expect(
      clearLocalJourney('postgres://db.example.com/neondb', createJourneyStore({ store: blobs })),
    ).rejects.toBeInstanceOf(RemoteDatabaseError)
    expect([...blobs.blobs.keys()]).toEqual(['m/1/manifest'])
  })
})
