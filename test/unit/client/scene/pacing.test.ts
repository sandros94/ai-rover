import { describe, expect, it } from 'vitest'
import { framePacer, INTERACTION_TAIL_MS } from '#shared/utils/client/scene/pacing'

/** Frames drawn in a second of a display refreshing at `hz`, every frame asked for. */
function drawnIn(pacer: ReturnType<typeof framePacer>, hz: number, from = 0): number {
  let drawn = 0
  for (let k = 0; k < hz; k++) {
    const now = from + (k * 1000) / hz
    if (!pacer.due(now)) continue
    pacer.drawn(now)
    drawn++
  }
  return drawn
}

describe('framePacer', () => {
  it('draws at most the cap while nothing is handled, whatever the display rate', () => {
    expect(
      drawnIn(
        framePacer(() => 60),
        240,
      ),
    ).toBe(60)
    expect(
      drawnIn(
        framePacer(() => 60),
        144,
      ),
    ).toBeLessThanOrEqual(72)
    expect(
      drawnIn(
        framePacer(() => 30),
        240,
      ),
    ).toBe(30)
  })

  it('keeps every frame of a display at the cap, jitter and all', () => {
    const pacer = framePacer(() => 60)
    let drawn = 0
    for (let k = 0; k < 60; k++) {
      const now = k * 16.667 + (k % 2 ? 1 : -1)
      if (pacer.due(now)) {
        pacer.drawn(now)
        drawn++
      }
    }
    expect(drawn).toBe(60)
  })

  it('draws every frame at the display’s rate while the view is handled, and for the tail after', () => {
    const pacer = framePacer(() => 60)
    pacer.interact(0)
    expect(pacer.interacting(INTERACTION_TAIL_MS - 1)).toBe(true)
    expect(drawnIn(pacer, 240)).toBe(240)
    expect(pacer.interacting(INTERACTION_TAIL_MS)).toBe(false)
    expect(drawnIn(pacer, 240, 1000)).toBe(60)
  })

  it('reads the cap each frame, so a new quality applies at once', () => {
    let cap = 60
    const pacer = framePacer(() => cap)
    expect(drawnIn(pacer, 240)).toBe(60)
    cap = 30
    expect(drawnIn(pacer, 240, 1000)).toBe(30)
  })

  it('keeps the longer of two handling windows', () => {
    const pacer = framePacer(() => 60)
    pacer.interact(0, 2000)
    pacer.interact(100)
    expect(pacer.interacting(1900)).toBe(true)
  })
})
