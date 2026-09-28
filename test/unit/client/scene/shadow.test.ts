import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import {
  heldSunDirection,
  SHADOW_DEPTH_STEP_M,
  SHADOW_HALF_MAX_M,
  SHADOW_HALF_MIN_M,
  SHADOW_STEP,
  shadowHalf,
  snapShadowCentre,
  SUN_HOLD_RAD,
} from '#shared/utils/client/scene/shadow'

const unit = (x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z)
  return { x: x / l, y: y / l, z: z / l }
}

/** The point in the frame of a shadow camera three builds for the sun at `toSun`, world z up. */
function inLightFrame(
  point: { x: number; y: number; z: number },
  toSun: { x: number; y: number; z: number },
) {
  const view = new Matrix4().lookAt(
    new Vector3(toSun.x, toSun.y, toSun.z),
    new Vector3(),
    new Vector3(0, 0, 1),
  )
  return new Vector3(point.x, point.y, point.z).applyMatrix4(view.invert())
}

describe('snapShadowCentre', () => {
  const toSun = unit(0.4, -0.7, 0.55)
  const texel = (2 * SHADOW_HALF_MIN_M) / 2048

  it('lands on whole texels across the light and whole depth steps along it, in the shadow camera’s own frame', () => {
    for (const p of [
      { x: 1234.567, y: -987.654, z: 12.3 },
      { x: 0.01, y: 0.02, z: 0 },
      { x: -40.5, y: 7.25, z: -3.3 },
    ]) {
      const light = inLightFrame(snapShadowCentre(p, toSun, texel), toSun)
      expect(Math.abs(light.x / texel - Math.round(light.x / texel))).toBeLessThan(1e-6)
      expect(Math.abs(light.y / texel - Math.round(light.y / texel))).toBeLessThan(1e-6)
      expect(
        Math.abs(light.z / SHADOW_DEPTH_STEP_M - Math.round(light.z / SHADOW_DEPTH_STEP_M)),
      ).toBeLessThan(1e-6)
    }
  })

  it('moves only in whole texels as the target drives, and not at all within a texel', () => {
    const start = { x: 500, y: 300, z: 10 }
    const first = inLightFrame(snapShadowCentre(start, toSun, texel), toSun)
    let moves = 0
    let previous = first
    // A rover at 4 cm/s seen at 60 frames a second, for ten seconds.
    for (let frame = 1; frame <= 600; frame++) {
      const p = {
        x: start.x + frame * 0.0006,
        y: start.y + frame * 0.0004,
        z: start.z + frame * 0.00001,
      }
      const light = inLightFrame(snapShadowCentre(p, toSun, texel), toSun)
      const du = (light.x - previous.x) / texel
      const dv = (light.y - previous.y) / texel
      expect(Math.abs(du - Math.round(du))).toBeLessThan(1e-6)
      expect(Math.abs(dv - Math.round(dv))).toBeLessThan(1e-6)
      if (du !== 0 || dv !== 0) moves++
      previous = light
    }
    expect(moves).toBeGreaterThan(0)
    expect(moves).toBeLessThan(600 / 10)
  })

  it('stays within half a texel across and half a depth step along the light of the point it snaps', () => {
    const p = { x: 17.3, y: -4.2, z: 2.1 }
    const snapped = inLightFrame(snapShadowCentre(p, toSun, texel), toSun)
    const light = inLightFrame(p, toSun)
    expect(Math.abs(snapped.x - light.x)).toBeLessThanOrEqual(texel / 2 + 1e-9)
    expect(Math.abs(snapped.y - light.y)).toBeLessThanOrEqual(texel / 2 + 1e-9)
    expect(Math.abs(snapped.z - light.z)).toBeLessThanOrEqual(SHADOW_DEPTH_STEP_M / 2 + 1e-9)
  })

  it('keeps the shadow camera’s frame with the sun straight overhead', () => {
    const overhead = { x: 0, y: 0, z: 1 }
    const light = inLightFrame(
      snapShadowCentre({ x: 3.3, y: 4.4, z: 0 }, overhead, texel),
      overhead,
    )
    expect(Math.abs(light.x / texel - Math.round(light.x / texel))).toBeLessThan(1e-6)
    expect(Math.abs(light.y / texel - Math.round(light.y / texel))).toBeLessThan(1e-6)
  })
})

describe('heldSunDirection', () => {
  const turned = (angle: number) => ({ x: Math.cos(angle), y: 0, z: Math.sin(angle) })

  it('takes the first direction it is given', () => {
    expect(heldSunDirection(undefined, turned(0.3))).toEqual(turned(0.3))
  })

  it('holds the light until the sun has turned the threshold, then follows it', () => {
    const held = turned(0.3)
    expect(heldSunDirection(held, turned(0.3 + SUN_HOLD_RAD * 0.99))).toBe(held)
    expect(heldSunDirection(held, turned(0.3 - SUN_HOLD_RAD * 0.5))).toBe(held)
    expect(heldSunDirection(held, turned(0.3 + SUN_HOLD_RAD * 1.01))).toEqual(
      turned(0.3 + SUN_HOLD_RAD * 1.01),
    )
  })

  it('steps through a slowly turning sun in whole thresholds', () => {
    let held = turned(0)
    let steps = 0
    // A tenth of the threshold per frame for 1000 frames.
    for (let frame = 1; frame <= 1000; frame++) {
      const next = heldSunDirection(held, turned((frame * SUN_HOLD_RAD) / 10))
      if (next !== held) steps++
      held = next
    }
    expect(steps).toBeGreaterThanOrEqual(90)
    expect(steps).toBeLessThanOrEqual(100)
  })
})

describe('shadowHalf', () => {
  it('covers at least the least square, grows in steps with the camera distance, and stops at the cap', () => {
    expect(shadowHalf(5)).toBe(SHADOW_HALF_MIN_M)
    expect(shadowHalf(SHADOW_HALF_MIN_M / 1.2)).toBe(SHADOW_HALF_MIN_M)
    expect(shadowHalf(SHADOW_HALF_MIN_M / 1.2 + 0.5)).toBeCloseTo(
      SHADOW_HALF_MIN_M * SHADOW_STEP,
      9,
    )
    expect(shadowHalf(1000)).toBe(SHADOW_HALF_MAX_M)
  })

  it('grows as soon as the camera needs it but shrinks only past the margin', () => {
    const threshold = SHADOW_HALF_MIN_M / 1.2
    const big = shadowHalf(threshold + 1)
    expect(big).toBeGreaterThan(SHADOW_HALF_MIN_M)
    // Settling back and forth around the threshold keeps the larger square.
    for (const d of [threshold - 0.5, threshold + 0.4, threshold - 1, threshold]) {
      expect(shadowHalf(d, big)).toBe(big)
    }
    expect(shadowHalf(threshold * 0.85, big)).toBe(SHADOW_HALF_MIN_M)
    expect(shadowHalf(threshold + 1, SHADOW_HALF_MIN_M)).toBe(big)
  })
})
