import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'
import { assertLoopback } from './loopback'

/**
 * Deletes every key of the journey store and says how many it deleted. Refuses, deleting
 * nothing, unless `url` (the database `useDB()` reaches) is on this machine: a database
 * elsewhere means the environment is not this machine's either.
 */
export async function clearLocalJourney(
  url: string | undefined,
  store: JourneyStore = createJourneyStore(),
): Promise<{ deleted: number }> {
  assertLoopback(url)
  const keys = await store.listKeys()
  for (const key of keys) await store.delete(key)
  return { deleted: keys.length }
}
