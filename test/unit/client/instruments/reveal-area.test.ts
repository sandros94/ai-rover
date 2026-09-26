import { describe, expect, it } from 'vitest'
import { revealRate, revealedAreaM2 } from '#shared/utils/client/instruments/reveal-area'

const reveal = (t: number, count: number) => ({ t, vertices: new Uint32Array(count) })
const REVEALS = [reveal(0, 400), reveal(30, 100), reveal(90, 50), reveal(200, 10)]

describe('revealedAreaM2', () => {
  it('sums the vertices revealed up to t times the cell area', () => {
    expect(revealedAreaM2(REVEALS, 0, 1)).toBe(400)
    expect(revealedAreaM2(REVEALS, 89.9, 1)).toBe(500)
    expect(revealedAreaM2(REVEALS, 1000, 2)).toBe(560 * 4)
    expect(revealedAreaM2([], 10, 1)).toBe(0)
  })
})

describe('revealRate', () => {
  it('bins square metres per minute from 0 to t', () => {
    expect(revealRate(REVEALS, 150, 1)).toEqual([500, 50, 0])
    expect(revealRate(REVEALS, 59, 1)).toEqual([500])
  })

  it('scales the bins by the cell area and bin length', () => {
    expect(revealRate(REVEALS, 150, 2, { binS: 120 })).toEqual([(550 * 4) / 2, 0])
  })
})
