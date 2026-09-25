import { describe, expect, it } from 'vitest'
import { buildCostMap } from '#shared/utils/nav'
import { navErrorOf, syntheticDisk } from './helpers'

const SIZE = 21
const HALF = 10
const at = (x: number, y: number): number => (y + HALF) * SIZE + x + HALF

describe('buildCostMap', () => {
  it('is 1 inside the radius on flat revealed ground and Infinity outside it', () => {
    const disk = syntheticDisk({ size: SIZE, radius: 8 })
    const costs = buildCostMap(disk, {
      revealed: new Uint8Array(SIZE * SIZE).fill(1),
      slopeLimitDeg: 16,
    })
    expect(costs.length).toBe(SIZE * SIZE)
    for (let y = -HALF; y <= HALF; y++) {
      for (let x = -HALF; x <= HALF; x++)
        expect(costs[at(x, y)]).toBe(Math.hypot(x, y) <= 8 ? 1 : Infinity)
    }
  })

  it('is Infinity on untraversable and NaN-height vertices', () => {
    const disk = syntheticDisk({
      size: SIZE,
      radius: 9,
      blocked: (x, y) => x === 2 && y === 3,
      heightAt: (x, y) => (x === -4 && y === 0 ? Number.NaN : 0),
    })
    const costs = buildCostMap(disk, {
      revealed: new Uint8Array(SIZE * SIZE).fill(1),
      slopeLimitDeg: 16,
    })
    expect(costs[at(2, 3)]).toBe(Infinity)
    expect(costs[at(-4, 0)]).toBe(Infinity)
    expect(costs[at(0, 0)]).toBe(1)
  })

  it('prices unrevealed vertices at the penalty, whatever their true slope or traversability', () => {
    const disk = syntheticDisk({
      size: SIZE,
      radius: 8,
      heightAt: (x) => 0.2 * x,
      blocked: (x, y) => x === 2 && y === 2,
    })
    const revealed = new Uint8Array(SIZE * SIZE).fill(1)
    revealed[at(1, 1)] = 0
    revealed[at(2, 2)] = 0
    const byDefault = buildCostMap(disk, { revealed, slopeLimitDeg: 16 })
    expect(byDefault[at(1, 1)]).toBe(3)
    expect(byDefault[at(2, 2)]).toBe(3)
    expect(byDefault[at(0, 0)]).toBeGreaterThan(1)
    const custom = buildCostMap(disk, { revealed, slopeLimitDeg: 16, unrevealedPenalty: 5 })
    expect(custom[at(1, 1)]).toBe(5)
    expect(custom[at(2, 2)]).toBe(5)
  })

  it('keeps unrevealed vertices without height or outside the radius impassable', () => {
    const disk = syntheticDisk({
      size: SIZE,
      radius: 8,
      heightAt: (x, y) => (x === -4 && y === 0 ? Number.NaN : 0),
    })
    const costs = buildCostMap(disk, { revealed: new Uint8Array(SIZE * SIZE), slopeLimitDeg: 16 })
    expect(costs[at(-4, 0)]).toBe(Infinity)
    expect(costs[at(9, 0)]).toBe(Infinity)
    expect(costs[at(0, 0)]).toBe(3)
  })

  it('grows monotonically with slope and matches the quadratic term', () => {
    const limit = 16
    const costs = [0.02, 0.1, 0.2, 0.28].map((grade) => {
      const disk = syntheticDisk({ size: SIZE, radius: 8, heightAt: (x) => grade * x })
      const map = buildCostMap(disk, {
        revealed: new Uint8Array(SIZE * SIZE).fill(1),
        slopeLimitDeg: limit,
      })
      const expected = 1 + 4 * (grade / Math.tan((limit * Math.PI) / 180)) ** 2
      expect(map[at(0, 0)]).toBeCloseTo(expected, 5)
      return map[at(0, 0)]!
    })
    for (let k = 1; k < costs.length; k++) expect(costs[k]).toBeGreaterThan(costs[k - 1]!)
  })

  it('refuses a revealed mask of the wrong size and bad options', () => {
    const disk = syntheticDisk({ size: SIZE, radius: 8 })
    const revealed = new Uint8Array(SIZE * SIZE)
    expect(
      navErrorOf(() => buildCostMap(disk, { revealed: new Uint8Array(3), slopeLimitDeg: 16 }))
        ?.code,
    ).toBe('INVALID_INPUT')
    expect(navErrorOf(() => buildCostMap(disk, { revealed, slopeLimitDeg: 0 }))?.code).toBe(
      'INVALID_INPUT',
    )
    expect(
      navErrorOf(() => buildCostMap(disk, { revealed, slopeLimitDeg: 16, unrevealedPenalty: 0.5 }))
        ?.code,
    ).toBe('INVALID_INPUT')
    expect(
      navErrorOf(() => buildCostMap(disk, { revealed, slopeLimitDeg: 16, slopeWeight: -1 }))?.code,
    ).toBe('INVALID_INPUT')
  })
})
