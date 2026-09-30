import { describe, expect, it } from 'vitest'
import type { KeyframeBlock, WrittenSlice } from '#shared/utils/drive'
import { KEYFRAME_STRIDE, latestRoute, statusAt } from '#shared/utils/drive'
import {
  createOdometer,
  driveEfficiency,
  revealedAreaM2,
  slipOverLastMetre,
} from '#shared/utils/client/instruments'
import { journeyFixture } from './helpers'

const { record, slices, traces, segmentManifest } = journeyFixture()
const { sliceSeconds } = segmentManifest

/** Slices `k …` back to back, as a window opened at slice `k` holds them. */
function windowFrom(k: number): { block: KeyframeBlock; slices: WrittenSlice[] } {
  const held = slices.slice(k)
  const data = new Float32Array(held.reduce((n, s) => n + s.keyframes.length, 0))
  let offset = 0
  for (const slice of held) {
    data.set(slice.keyframes, offset)
    offset += slice.keyframes.length
  }
  const count = data.length / KEYFRAME_STRIDE
  return { block: { ...record.keyframes, count, data }, slices: held }
}

describe('slice totals over the recorded drive', () => {
  const whole = createOdometer(record.keyframes)
  const end = record.outcome.durationS

  it('stops and resumes within the drive, so the status totals are exercised', () => {
    expect(slices.length).toBeGreaterThan(20)
    expect(slices.some((s) => s.totals.status && s.totals.status.status !== 'driving')).toBe(true)
  })

  it('give every reading a window from any slice would otherwise integrate from t = 0', () => {
    for (const [k, slice] of slices.entries()) {
      const { block, slices: held } = windowFrom(k)
      const { totals } = slice
      const odometer = createOdometer(block, totals)
      const events = held.flatMap((s) => s.events)
      for (let t = k * sliceSeconds + 0.65; t <= end + 1; t += 1.3) {
        const reading = odometer.at(t)
        const expected = whole.at(t)
        expect(reading.actualM, `slice ${k}, t = ${t}`).toBeCloseTo(expected.actualM, 9)
        expect(reading.commandedM, `slice ${k}, t = ${t}`).toBeCloseTo(expected.commandedM, 9)
        expect(driveEfficiency({ actualM: reading.actualM, elapsedS: t })).toBeCloseTo(
          driveEfficiency({ actualM: expected.actualM, elapsedS: t })!,
          9,
        )
        // The trail leaves out frames within a tenth of a milliradian of wheel rotation.
        const slip = slipOverLastMetre(odometer, t)
        const full = slipOverLastMetre(whole, t)
        expect(slip.actualM, `slice ${k}, t = ${t}`).toBeCloseTo(full.actualM, 5)
        expect(slip.commandedM, `slice ${k}, t = ${t}`).toBeCloseTo(full.commandedM, 4)
        expect(slip.slip, `slice ${k}, t = ${t}`).toBeCloseTo(full.slip, 4)
        const reached = events.filter((e) => e.t <= t)
        expect(statusAt(reached, t, totals.status), `slice ${k}, t = ${t}`).toEqual(
          statusAt(
            record.events.filter((e) => e.t <= t),
            t,
          ),
        )
        expect(latestRoute(reached) ?? totals.route, `slice ${k}, t = ${t}`).toEqual(
          latestRoute(record.events.filter((e) => e.t <= t)),
        )
      }
    }
  })

  it('leave the reveals to the traces, which a window loads from the first slice', () => {
    const reveals = traces.flatMap((t) => t.reveals)
    expect(reveals).toEqual(record.reveals)
    for (const t of [0, 100, 555.5, end]) {
      expect(revealedAreaM2(reveals, t, 1)).toBe(revealedAreaM2(record.reveals, t, 1))
    }
  })
})
