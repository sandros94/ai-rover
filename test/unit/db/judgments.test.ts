import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { getJudgment, jevCacheOver, putJudgment } from '#server/repositories/judgments'
import type { JudgedAnswers } from '#server/utils/jev/client'
import { createJevClient, JEV_MODEL } from '#server/utils/jev/client'
import { answersFetch } from '../jev/helpers'
import { createTestDb, JUDGMENT, SUMMARY } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const ANSWERS: JudgedAnswers = {
  feasible: JUDGMENT.feasible,
  distanceConfidence: JUDGMENT.distanceConfidence,
  timeConfidence: JUDGMENT.timeConfidence,
  risk: JUDGMENT.risk,
}

describe('jev judgments', () => {
  it('stores answers by hash and keeps the first answers written', async () => {
    const hash = 'a'.repeat(64)
    expect(await getJudgment(db, hash)).toBeUndefined()
    await putJudgment(db, { hash, model: JEV_MODEL, answers: ANSWERS })
    expect(await getJudgment(db, hash)).toEqual(ANSWERS)
    // A second writer of the same request, after a race, changes nothing and does not fail.
    await putJudgment(db, { hash, model: JEV_MODEL, answers: { ...ANSWERS, feasible: 0.1 } })
    expect(await getJudgment(db, hash)).toEqual(ANSWERS)
  })

  it('serves as the Jev cache: a second client pays for nothing already judged', async () => {
    const first = answersFetch(0.9)
    const judged = await createJevClient({
      apiKey: 'k',
      fetch: first.fetch,
      cache: jevCacheOver(db),
    }).judgeSubmission(SUMMARY)
    const second = answersFetch(0.9)
    const again = await createJevClient({
      apiKey: 'k',
      fetch: second.fetch,
      cache: jevCacheOver(db),
    }).judgeSubmission(SUMMARY)
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
    expect(again.cached).toBe(true)
    expect({ ...again, cached: false, usage: judged.usage }).toEqual(judged)
  })
})
