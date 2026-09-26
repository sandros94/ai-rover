import { describe, expect, it } from 'vitest'
import { FIXTURE_NAMES, fixtureRecord } from '~~/modules/dev/runtime/server/utils/fixtures'

describe('playground fixtures', () => {
  it('lists the three seeds', () => {
    expect(FIXTURE_NAMES).toEqual(['mars', 'jezero', 'gale'])
  })

  it('drives a fixture once and serves the cached record after', () => {
    const first = fixtureRecord('jezero')!
    expect(first.start).toEqual({ x: 0, y: 0, headingRad: 0 })
    expect(Math.hypot(first.goal.x, first.goal.y)).toBe(150)
    expect(first.keyframes.count).toBeGreaterThan(1)
    expect(fixtureRecord('jezero')).toBe(first)
  })

  it('returns undefined for an unknown name', () => {
    expect(fixtureRecord('olympus')).toBeUndefined()
  })
})
