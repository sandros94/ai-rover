/**
 * Records the Jev fixtures under `test/fixtures/jev/`: six submissions on generated worlds, one
 * live request each, stored as `{ request, response }` (request body and response body only).
 * Deterministic apart from Jev's own answers; re-running overwrites the files.
 *
 * Run from the repository root (reads NUXT_TYPESAFE_TOKEN from .env):
 *
 *   JITI_ALIAS="{\"#shared\":\"$PWD/shared\",\"#server\":\"$PWD/server\"}" pnpm exec jiti scripts/jev-record.ts
 */
import { planSegment, summarizeSubmission } from '#shared/utils/nav'
import { createJevClient } from '#server/utils/jev/client'
import { apiKeyFromEnv, firstStop, printTable, recordingFetch, writeFixture } from './jev-shared'

const CASES = [
  { name: 'mars-north-short', seed: 'mars', goal: { x: 0, y: 80 } },
  { name: 'mars-east-long-unseen', seed: 'mars', goal: { x: 220, y: 0 } },
  { name: 'jezero-north-west-detour', seed: 'jezero', goal: { x: -57, y: 57 } },
  // Seen impassable ground at the destination: the planner reports goal-blocked.
  { name: 'jezero-south-east-blocked', seed: 'jezero', goal: { x: 84, y: -100 } },
  { name: 'gale-east-mostly-unseen', seed: 'gale', goal: { x: 140, y: 0 } },
  { name: 'gale-south-east-detour', seed: 'gale', goal: { x: 99, y: -99 } },
] as const

const START = { x: 0, y: 0 }

const recorder = recordingFetch()
const jev = createJevClient({ apiKey: apiKeyFromEnv(), fetch: recorder.fetch, maxRetries: 0 })
let inputTokens = 0
const rows: string[][] = []
for (const { name, seed, goal } of CASES) {
  const { world, disk, revealed } = firstStop(seed)
  const plan = planSegment(disk, {
    revealed,
    start: START,
    goal,
    slopeLimitDeg: world.config.slopeLimitDeg,
  })
  const summary = summarizeSubmission(plan, { world, disk, revealed, start: START, goal })
  const judgment = await jev.judgeSubmission(summary)
  const exchange = recorder.exchanges.at(-1)!
  writeFixture(name, exchange)
  inputTokens += judgment.usage?.inputTokens ?? 0
  const r = summary.route
  rows.push([
    name,
    r.reached
      ? `${r.path_length_m} m, ${r.detour_label}, ${r.max_slope_label}, ${r.unseen_label}, ${r.loose_ground_label}`
      : `not reached`,
    judgment.feasible.toFixed(3),
    judgment.distanceConfidence.score.toFixed(2),
    judgment.timeConfidence.score.toFixed(2),
    judgment.risk.score.toFixed(2),
    judgment.verdict,
  ])
}
printTable(['case', 'route', 'feasible', 'distance', 'time', 'risk', 'verdict'], rows)
console.log(`\n${recorder.exchanges.length} requests, ${inputTokens} input tokens`)
