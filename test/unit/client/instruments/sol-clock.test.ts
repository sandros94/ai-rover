import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatLmst,
  MARS_SOL_SECONDS,
  solTime,
} from '#shared/utils/client/instruments/sol-clock'

const EPOCH = Date.UTC(2026, 8, 1, 12, 0, 0)

describe('solTime', () => {
  it('starts sol 0 at local midnight on the mission epoch', () => {
    const at = solTime(EPOCH, EPOCH)
    expect(at).toMatchObject({ sol: 0, hours: 0, minutes: 0, seconds: 0 })
    expect(formatLmst(at)).toBe('00:00:00')
  })

  it('reads sol 2, 18:00 LMST two and three quarter sols later', () => {
    const at = solTime(EPOCH, EPOCH + 2.75 * MARS_SOL_SECONDS * 1000)
    expect(at.sol).toBe(2)
    expect(formatLmst(at)).toBe('18:00:00')
    expect(at.fraction).toBeCloseTo(0.75, 9)
  })

  it('turns the sol exactly one sol of SI seconds after the epoch', () => {
    expect(MARS_SOL_SECONDS).toBe(88_775.244)
    expect(solTime(EPOCH, EPOCH + MARS_SOL_SECONDS * 1000 - 1).sol).toBe(0)
    expect(solTime(EPOCH, EPOCH + MARS_SOL_SECONDS * 1000).sol).toBe(1)
  })

  it('refuses a non-finite instant', () => {
    expect(() => solTime(EPOCH, Number.NaN)).toThrow(/epoch milliseconds/)
  })
})

describe('formatDuration', () => {
  it('reads seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(3_725)).toBe('1:02:05')
  })
})
