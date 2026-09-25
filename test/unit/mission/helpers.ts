import { count } from 'drizzle-orm'
import type { DB } from '#server/database/db'
import type { StoredJudgment } from '#server/database/schema'
import { schema } from '#server/database/schema'
import { createUser } from '#server/repositories/users'
import type { JevClient, SubmissionJudgment } from '#server/utils/jev/client'
import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'
import type { SubmissionSummary } from '#shared/utils/nav'
import { MemoryBlobs } from '../journey/helpers'
import { JUDGMENT } from '../db/helpers'

export { createTestDb, dbErrorOf } from '../db/helpers'

/** Wall-clock zero of every lifecycle test; far from the database's own clock on purpose. */
export const T0 = new Date('2030-01-01T00:00:00Z')

export function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms)
}

export const MINUTE = 60_000

export function memoryStore(): { store: JourneyStore; blobs: MemoryBlobs } {
  const blobs = new MemoryBlobs()
  return { store: createJourneyStore({ store: blobs }), blobs }
}

/**
 * A Jev client answering from `judge` (default: the accepting fixture judgment), recording every
 * summary it was asked about.
 */
export function fakeJev(
  judge: (summary: SubmissionSummary) => Partial<StoredJudgment> = () => ({}),
) {
  const summaries: SubmissionSummary[] = []
  const client: JevClient = {
    async judgeSubmission(summary) {
      summaries.push(summary)
      const judgment: SubmissionJudgment = {
        ...structuredClone(JUDGMENT),
        ...judge(summary),
        cached: false,
      }
      return judgment
    },
  }
  return { client, summaries }
}

export async function users(db: DB, ...names: string[]) {
  return Promise.all(names.map((displayName) => createUser(db, { displayName })))
}

/** Row count of every table, to compare before and after an operation. */
export async function tableCounts(db: DB): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [name, table] of Object.entries(schema)) {
    const [row] = await db.select({ n: count() }).from(table)
    counts[name] = row!.n
  }
  return counts
}
