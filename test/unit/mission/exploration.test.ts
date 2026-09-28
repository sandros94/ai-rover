import { describe, expect, it } from 'vitest'
import type { ExplorationParts, MissionHistory } from '#shared/utils/mission'
import {
  DEFAULT_MISSION_RULES,
  drivenPath,
  explorationParts,
  explorationValue,
  MissionError,
  POCKET_PATH_RADIUS_M,
} from '#shared/utils/mission'
import { planSegment } from '#shared/utils/nav'
import { syntheticDisk } from '../nav/helpers'

const size = 201
const half = (size - 1) / 2
const disk = syntheticDisk({ size, radius: 100 })
const slopeLimitDeg = 16
const start = { x: 0, y: 0 }
const none: Pick<MissionHistory, 'drivenPaths'> = { drivenPaths: [] }

/** Revealed bytes: seen where `seen(x, y)` holds, world metres. */
function mask(seen: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(size * size)
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) out[j * size + i] = seen(i - half, j - half) ? 1 : 0
  return out
}

function partsFor(
  revealed: Uint8Array,
  goal: { x: number; y: number },
  history: Pick<MissionHistory, 'drivenPaths'> = none,
  on = disk,
): ExplorationParts {
  const plan = planSegment(on, { revealed, start, goal, slopeLimitDeg })
  return explorationParts(plan, { disk: on, revealed, goal, history })
}

describe('explorationParts', () => {
  it('is all zero for a seen goal reached over seen ground', () => {
    expect(
      partsFor(
        mask(() => true),
        { x: 60, y: 0 },
      ),
    ).toEqual({
      pathInFog: 0,
      goalInFog: 0,
      pocket: 0,
    })
  })

  it("takes the path's unseen share from the plan and marks a goal in the fog", () => {
    // Everything east of x = 30 unseen, out to the survey's edge.
    const revealed = mask((x) => x < 30)
    const goal = { x: 80, y: 0 }
    const plan = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    const parts = explorationParts(plan, { disk, revealed, goal, history: none })
    expect(parts.pathInFog).toBe(plan.metrics.unrevealedFraction)
    expect(parts.pathInFog).toBeGreaterThan(0.5)
    expect(parts.goalInFog).toBe(1)
    // Open fog reaching the survey circle, and nothing driven yet.
    expect(parts.pocket).toBe(0)
  })

  it('counts fog enclosed by seen ground as a pocket', () => {
    const revealed = mask((x, y) => Math.max(Math.abs(x - 50), Math.abs(y - 10)) > 6)
    expect(partsFor(revealed, { x: 50, y: 10 }).pocket).toBe(1)
  })

  it('counts open fog within 20 m of a driven path as a pocket, and scales it beyond', () => {
    const revealed = mask((x) => x < 30)
    const path = {
      drivenPaths: [
        [
          { x: -80, y: 40 },
          { x: 80, y: 40 },
        ],
      ],
    }
    expect(partsFor(revealed, { x: 60, y: 20 }, path).pocket).toBe(1)
    expect(partsFor(revealed, { x: 60, y: 40 - POCKET_PATH_RADIUS_M }, path).pocket).toBe(1)
    expect(partsFor(revealed, { x: 60, y: 0 }, path).pocket).toBeCloseTo(0.5, 12)
    expect(partsFor(revealed, { x: 60, y: -40 }, path).pocket).toBeCloseTo(0.25, 12)
  })

  it('reads only the revealed mask and the paths for the pocket, whatever the fog hides', () => {
    const revealed = mask((x, y) => Math.max(Math.abs(x - 50), Math.abs(y - 10)) > 6 && x < 90)
    const goal = { x: 50, y: 10 }
    const plan = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    const expected = explorationParts(plan, { disk, revealed, goal, history: none })
    const hidden = syntheticDisk({
      size,
      radius: 100,
      heightAt: (x, y) => (x * 7 + y * 13) % 40,
      blocked: (x, y) => (x + y) % 3 === 0,
    })
    // The same plan over other hidden ground: only the mask and the survey are read.
    expect(explorationParts(plan, { disk: hidden, revealed, goal, history: none })).toEqual(
      expected,
    )
  })

  it('has no path share for a route not reached', () => {
    const blocked = syntheticDisk({
      size,
      radius: 100,
      blocked: (x, y) => Math.hypot(x - 60, y) < 5,
    })
    const revealed = mask((x) => x < 30 || x > 50)
    const goal = { x: 60, y: 0 }
    const plan = planSegment(blocked, { revealed, start, goal, slopeLimitDeg })
    expect(plan.metrics.reached).toBe(false)
    expect(explorationParts(plan, { disk: blocked, revealed, goal, history: none })).toEqual({
      pathInFog: 0,
      goalInFog: 0,
      pocket: 0,
    })
  })

  it('refuses a goal beyond the survey or a mask of another size', () => {
    const revealed = mask(() => true)
    const plan = planSegment(disk, { revealed, start, goal: { x: 60, y: 0 }, slopeLimitDeg })
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof MissionError ? error.code : 'other'
      }
    }
    const history = none
    expect(
      code(() => explorationParts(plan, { disk, revealed, goal: { x: 100, y: 100 }, history })),
    ).toBe('INVALID_INPUT')
    expect(
      code(() =>
        explorationParts(plan, {
          disk,
          revealed: new Uint8Array(4),
          goal: { x: 60, y: 0 },
          history,
        }),
      ),
    ).toBe('INVALID_INPUT')
  })
})

describe('explorationValue', () => {
  const weights = DEFAULT_MISSION_RULES.explorationWeights

  it('weighs the parts 0.4, 0.3 and 0.3 by default', () => {
    expect(weights).toEqual({ pathInFog: 0.4, goalInFog: 0.3, pocket: 0.3 })
    expect(explorationValue({ pathInFog: 1, goalInFog: 0, pocket: 0 }, { weights })).toBeCloseTo(
      0.4,
      12,
    )
    expect(explorationValue({ pathInFog: 0.5, goalInFog: 1, pocket: 0 }, { weights })).toBeCloseTo(
      0.5,
      12,
    )
    expect(explorationValue({ pathInFog: 1, goalInFog: 1, pocket: 1 }, { weights })).toBeCloseTo(
      1,
      12,
    )
    expect(explorationValue({ pathInFog: 0, goalInFog: 0, pocket: 0 }, { weights })).toBe(0)
  })

  it('normalises by the weights and refuses weights that sum to nothing', () => {
    const parts = { pathInFog: 1, goalInFog: 0, pocket: 1 }
    expect(
      explorationValue(parts, { weights: { pathInFog: 2, goalInFog: 1, pocket: 1 } }),
    ).toBeCloseTo(0.75, 12)
    expect(() =>
      explorationValue(parts, { weights: { pathInFog: 0, goalInFog: 0, pocket: 0 } }),
    ).toThrow(MissionError)
  })
})

describe('drivenPath', () => {
  const plan = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]

  it('keeps the plan up to the point nearest the end, then the end', () => {
    expect(drivenPath(plan, { x: 60, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 3 },
    ])
    expect(drivenPath(plan, { x: 102, y: 40 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 102, y: 40 },
    ])
  })

  it('is the end alone without a plan', () => {
    expect(drivenPath([], { x: 5, y: 5 })).toEqual([{ x: 5, y: 5 }])
  })
})
