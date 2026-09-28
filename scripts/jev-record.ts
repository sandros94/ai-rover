/**
 * Records the Jev fixtures under `test/fixtures/jev/`: submissions on generated worlds, one live
 * request each, stored as `{ request, response }` (request body and response body only).
 * Deterministic apart from Jev's own answers; re-running overwrites the files. Names given as
 * arguments record only those cases.
 *
 * Run from the repository root (reads NUXT_TYPESAFE_TOKEN from .env):
 *
 *   JITI_ALIAS="{\"#shared\":\"$PWD/shared\",\"#server\":\"$PWD/server\"}" pnpm exec jiti scripts/jev-record.ts [name…]
 */
import type { MissionHistory } from '#shared/utils/mission'
import { explorationParts } from '#shared/utils/mission'
import { planSegment, summarizeSubmission } from '#shared/utils/nav'
import { createJevClient } from '#server/utils/jev/client'
import { apiKeyFromEnv, firstStop, printTable, recordingFetch, writeFixture } from './jev-shared'

/** A journey that came from the west: two earlier stops and the straight drives between them. */
const FROM_THE_WEST: MissionHistory = {
  drivenPaths: [
    [
      { x: -260, y: 60 },
      { x: -130, y: 20 },
    ],
    [
      { x: -130, y: 20 },
      { x: 0, y: 0 },
    ],
  ],
  recentStops: [
    { x: 0, y: 0 },
    { x: -130, y: 20 },
    { x: -260, y: 60 },
  ],
}

const CASES: {
  name: string
  seed: string
  goal: { x: number; y: number }
  history: MissionHistory
}[] = [
  // A destination in the fog, reached mostly over unseen ground, away from where the rover came from.
  { name: 'mars-east-fog-goal', seed: 'mars', goal: { x: 150, y: 0 }, history: FROM_THE_WEST },
  // Seen impassable ground at the destination: the planner reports goal-blocked.
  {
    name: 'jezero-south-east-blocked',
    seed: 'jezero',
    goal: { x: 84, y: -100 },
    history: FROM_THE_WEST,
  },
]

const START = { x: 0, y: 0 }

const only = process.argv.slice(2)
const chosen = only.length > 0 ? CASES.filter((c) => only.includes(c.name)) : CASES
const recorder = recordingFetch()
// Every case is a live request, so nothing is ever answered from a cache.
const jev = createJevClient({
  apiKey: apiKeyFromEnv(),
  fetch: recorder.fetch,
  maxRetries: 0,
  cache: { get: async () => undefined, set: async () => {} },
})
let inputTokens = 0
const rows: string[][] = []
for (const { name, seed, goal, history } of chosen) {
  const { world, disk, revealed } = firstStop(seed)
  const plan = planSegment(disk, {
    revealed,
    start: START,
    goal,
    slopeLimitDeg: world.config.slopeLimitDeg,
  })
  const exploration = explorationParts(plan, { disk, revealed, goal, history })
  const summary = summarizeSubmission(plan, {
    world,
    disk,
    revealed,
    start: START,
    goal,
    exploration,
    history,
  })
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
    judgment.explorationValue.score.toFixed(2),
    judgment.verdict,
  ])
}
printTable(
  ['case', 'route', 'feasible', 'distance', 'time', 'risk', 'exploration', 'verdict'],
  rows,
)
console.log(`\n${recorder.exchanges.length} requests, ${inputTokens} input tokens`)
