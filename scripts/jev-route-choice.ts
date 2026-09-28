/**
 * Route-choice experiment: does Jev, shown several candidate routes to one destination, prefer
 * the one the planner finds cheapest? Per seed, the same start and goal are planned under six cost
 * settings (slopeWeight 1, 4, 16 × unrevealedPenalty 1, 3), identical polylines are merged, and
 * ONE request asks a Choice `best_route` over the candidates' summaries plus one Noul `safe_<k>`
 * per candidate. Prints a table per seed and saves each raw exchange as
 * `test/fixtures/jev/route-choice-<seed>.json` (evidence, not a test input). Three live requests.
 *
 * Run from the repository root (reads NUXT_TYPESAFE_TOKEN from .env):
 *
 *   JITI_ALIAS="{\"#shared\":\"$PWD/shared\",\"#server\":\"$PWD/server\"}" pnpm exec jiti scripts/jev-route-choice.ts
 */
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk'
import { explorationParts } from '#shared/utils/mission'
import type { SegmentPlan } from '#shared/utils/nav'
import { buildCostMap, planSegment, summarizeSubmission } from '#shared/utils/nav'
import { traceSegment } from '#shared/utils/nav/trace'
import type { StopDisk } from '#shared/utils/terrain'
import { JEV_MODEL } from '#server/utils/jev/client'
import { apiKeyFromEnv, firstStop, printTable, recordingFetch, writeFixture } from './jev-shared'

const CASES = [
  { seed: 'mars', goal: { x: 220, y: 0 } },
  { seed: 'jezero', goal: { x: 0, y: 220 } },
  { seed: 'gale', goal: { x: 220, y: 0 } },
] as const

const SETTINGS = [1, 4, 16].flatMap((slopeWeight) =>
  [1, 3].map((unrevealedPenalty) => ({ slopeWeight, unrevealedPenalty })),
)

const START = { x: 0, y: 0 }

const recorder = recordingFetch()
const client = new TypeSafeClient({
  apiKey: apiKeyFromEnv(),
  defaultModel: JEV_MODEL,
  fetch: recorder.fetch,
  retry: { maxRetries: 0 },
})

let inputTokens = 0
let agreements = 0
for (const { seed, goal } of CASES) {
  const { world, disk, revealed } = firstStop(seed)
  const slopeLimitDeg = world.config.slopeLimitDeg
  const reference = buildCostMap(disk, { revealed, slopeLimitDeg })

  const candidates: { settings: string[]; plan: SegmentPlan; cost: number }[] = []
  for (const setting of SETTINGS) {
    const plan = planSegment(disk, { revealed, start: START, goal, slopeLimitDeg, ...setting })
    if (!plan.metrics.reached) continue
    const label = `w${setting.slopeWeight}/p${setting.unrevealedPenalty}`
    const same = candidates.find(
      (c) => JSON.stringify(c.plan.polyline) === JSON.stringify(plan.polyline),
    )
    if (same) same.settings.push(label)
    else candidates.push({ settings: [label], plan, cost: pathCost(disk, reference, plan) })
  }

  const ids = candidates.map((_, k) => `route_${String.fromCharCode(97 + k)}`)
  const history = { drivenPaths: [], recentStops: [] }
  const summaries = candidates.map((c) =>
    summarizeSubmission(c.plan, {
      world,
      disk,
      revealed,
      start: START,
      goal,
      exploration: explorationParts(c.plan, { disk, revealed, goal, history }),
      history,
    }),
  )
  const { route: _route, ...common } = summaries[0]!
  const routes = Object.fromEntries(ids.map((id, k) => [id, summaries[k]!.route]))
  const questions = {
    best_route: choice(
      'Which route should the rover drive to reach the destination most reliably, arriving without being stopped short or failing?',
      routes,
    ),
    ...Object.fromEntries(
      ids.map((id) => [
        `safe_${id}`,
        noul({
          question:
            'Can the rover drive this route to the destination without being stopped short or failing?',
          route: routes[id]!,
        }),
      ]),
    ),
  }
  const result = await client.systemOne({ state: common, questions })
  writeFixture(`route-choice-${seed}`, recorder.exchanges.at(-1)!)
  inputTokens += result.usage.input_tokens

  const byCost = candidates.map((c, k) => ({ k, cost: c.cost })).sort((a, b) => a.cost - b.cost)
  const rankOf = (k: number) => byCost.findIndex((entry) => entry.k === k) + 1
  const best = result.answers.best_route as {
    choice: string
    probabilities: Record<string, number>
    confidence: number
  }
  const cheapest = ids[byCost[0]!.k]!
  if (best.choice === cheapest) agreements++

  console.log(`\n### ${seed}, goal (${goal.x}, ${goal.y})\n`)
  printTable(
    ['candidate', 'settings', 'route', 'planner cost', 'cost rank', 'Jev p(best)', 'safe noul'],
    candidates.map((c, k) => {
      const r = summaries[k]!.route
      const id = ids[k]!
      const safe = (result.answers as Record<string, unknown>)[`safe_${id}`] as { noul: number }
      return [
        id,
        c.settings.join(' '),
        r.reached
          ? `${r.path_length_m} m, ${r.detour_label}, ${r.max_slope_label} (${r.max_slope_deg}°), ${r.unseen_label}, ${r.loose_ground_label}, ${r.turns_in_place} turns`
          : 'not reached',
        c.cost.toFixed(0),
        `${rankOf(k)}`,
        best.probabilities[id]!.toFixed(3),
        safe.noul.toFixed(3),
      ]
    }),
  )
  console.log(
    `\nJev's top pick ${best.choice} (confidence ${best.confidence.toFixed(2)}) ${best.choice === cheapest ? 'equals' : 'differs from'} the planner's cheapest ${cheapest}.`,
  )
}
console.log(
  `\n${recorder.exchanges.length} requests, ${inputTokens} input tokens; top pick equals cheapest on ${agreements} of ${CASES.length} seeds.`,
)

/**
 * pathLength × mean cost under the reference cost map: the sum of vertex cost × length inside
 * each vertex cell along the route.
 */
function pathCost(disk: StopDisk, costs: Float32Array, plan: SegmentPlan): number {
  const { width, cellSize } = disk.grid
  const points = plan.route.waypoints
  let total = 0
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!
    const b = points[k]!
    const legM = Math.hypot(b.i - a.i, b.j - a.j) * cellSize
    traceSegment(width, a.j * width + a.i, b.j * width + b.i, (v, weight) => {
      total += costs[v]! * weight * legM
      return true
    })
  }
  return total
}
