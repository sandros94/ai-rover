import { describe, expect, it } from 'vitest'
import { ClientError, createDisplayClock, DISPLAY_SLEW_RATE } from '#shared/utils/client'

function setup(offsetMs = 0) {
  let monotonic = 0
  const clock = createDisplayClock({ monotonic: () => monotonic, offsetMs })
  return {
    clock,
    advance: (ms: number) => {
      monotonic += ms
      return clock.now()
    },
  }
}

describe('createDisplayClock', () => {
  it('shows the first offset at once', () => {
    const { clock, advance } = setup(5)
    expect(clock.now()).toBe(5)
    clock.setOffset(30_000)
    expect(advance(16)).toBe(30_016)
  })

  it('advances monotonically at real time within the slew rate while estimates jump by a second', () => {
    const { clock, advance } = setup()
    clock.setOffset(0)
    let previous = clock.now()
    const frameMs = 1000 / 60
    for (let poll = 0; poll < 60; poll++) {
      clock.setOffset(poll % 2 ? 1000 : -1000)
      for (let frame = 0; frame < 300; frame++) {
        const shown = advance(frameMs)
        const rate = (shown - previous) / frameMs
        expect(rate).toBeGreaterThanOrEqual(1 - DISPLAY_SLEW_RATE - 1e-9)
        expect(rate).toBeLessThanOrEqual(1 + DISPLAY_SLEW_RATE + 1e-9)
        previous = shown
      }
    }
  })

  it('reaches a steady offset by slewing', () => {
    const { clock, advance } = setup()
    clock.setOffset(0)
    clock.setOffset(1000)
    expect(advance(10_000)).toBe(10_000 + 10_000 * DISPLAY_SLEW_RATE)
    expect(advance(100_000)).toBe(111_000)
  })

  it('steps to the latest offset on a snap', () => {
    const { clock, advance } = setup()
    clock.setOffset(0)
    clock.setOffset(-1000)
    advance(1000)
    clock.snap()
    expect(clock.now()).toBe(0)
    expect(advance(500)).toBe(500)
  })

  it('refuses an offset that is not finite', () => {
    expect(() => setup(Number.NaN)).toThrow(ClientError)
    expect(() => setup().clock.setOffset(Infinity)).toThrow(ClientError)
  })
})
