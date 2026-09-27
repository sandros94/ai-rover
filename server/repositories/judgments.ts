import { eq } from 'drizzle-orm'
import type { DB } from '../database/db'
import { aiJudgment } from '../database/schema'
import type { JevCache, JudgedAnswers } from '../utils/jev/client'
import { JEV_MODEL } from '../utils/jev/client'

export async function getJudgment(db: DB, hash: string): Promise<JudgedAnswers | undefined> {
  const [row] = await db
    .select({ answers: aiJudgment.answers })
    .from(aiJudgment)
    .where(eq(aiJudgment.hash, hash))
  return row?.answers
}

/** Keeps the first answers stored under `hash`: two requests racing on one hash both succeed. */
export async function putJudgment(
  db: DB,
  input: { hash: string; model: string; answers: JudgedAnswers },
): Promise<void> {
  await db.insert(aiJudgment).values(input).onConflictDoNothing()
}

/** A Jev cache over the judgments table, for answers of {@link JEV_MODEL}. */
export function jevCacheOver(db: DB): JevCache {
  return {
    get: (hash) => getJudgment(db, hash),
    set: (hash, answers) => putJudgment(db, { hash, model: JEV_MODEL, answers }),
  }
}
