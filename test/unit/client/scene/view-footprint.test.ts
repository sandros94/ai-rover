import { describe, expect, it } from 'vitest'
import type { CameraPose } from '#shared/utils/client/scene'
import { HAZE_FAR_M, viewFootprint } from '#shared/utils/client/scene'

const round = (points: { x: number; y: number }[]) =>
  points.map(({ x, y }) => ({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))

/** A camera `distance` metres from `target` at `elevationDeg` above it, facing `headingDeg`. */
function orbiting(options: {
  target?: { x: number; y: number; z: number }
  distance: number
  elevationDeg: number
  headingDeg: number
  fovDeg?: number
  aspect?: number
}): CameraPose {
  const { target = { x: 0, y: 0, z: 0 }, distance, fovDeg = 50, aspect = 1.5 } = options
  const e = (options.elevationDeg * Math.PI) / 180
  const h = (options.headingDeg * Math.PI) / 180
  const back = { x: -Math.cos(h) * Math.cos(e), y: -Math.sin(h) * Math.cos(e), z: Math.sin(e) }
  return {
    position: {
      x: target.x + distance * back.x,
      y: target.y + distance * back.y,
      z: target.z + distance * back.z,
    },
    target,
    fovDeg,
    aspect,
    // Perpendicular to the view, toward the sky.
    up: { x: Math.cos(h) * Math.sin(e), y: Math.sin(h) * Math.sin(e), z: Math.cos(e) },
  }
}

describe('viewFootprint', () => {
  it('is the rectangle under a camera looking straight down, turned as the view is', () => {
    const tanV = Math.tan((50 * Math.PI) / 360)
    const camera: CameraPose = {
      position: { x: 10, y: 20, z: 105 },
      target: { x: 10, y: 20, z: 5 },
      fovDeg: 50,
      aspect: 2,
      // The top of the view is north.
      up: { x: 0, y: 1, z: 0 },
    }
    const footprint = viewFootprint(camera, 5, HAZE_FAR_M)!
    const [halfW, halfH] = [100 * tanV * 2, 100 * tanV]
    expect(round(footprint.polygon)).toEqual(
      round([
        { x: 10 - halfW, y: 20 - halfH },
        { x: 10 + halfW, y: 20 - halfH },
        { x: 10 + halfW, y: 20 + halfH },
        { x: 10 - halfW, y: 20 + halfH },
      ]),
    )
    expect(footprint.apex).toEqual({ x: 10, y: 20 })
    expect(footprint.headingRad).toBeCloseTo(Math.PI / 2, 9)
  })

  it('opens a trapezoid from near the camera, its far corners clipped at the range', () => {
    // Nearly level: the bottom of the view meets the ground, the top never does.
    const camera = orbiting({ distance: 30, elevationDeg: 10, headingDeg: 0 })
    const footprint = viewFootprint(camera, 0, HAZE_FAR_M)!
    const [nearLeft, nearRight, farRight, farLeft] = footprint.polygon
    const { apex } = footprint
    const range = (p: { x: number; y: number }) => Math.hypot(p.x - apex.x, p.y - apex.y)
    expect(footprint.polygon).toHaveLength(4)
    // Facing +x: the near edge ahead of the camera, left at +y.
    expect(nearLeft!.x).toBeGreaterThan(apex.x)
    expect(nearLeft!.y).toBeGreaterThan(0)
    expect(nearRight!.y).toBeCloseTo(-nearLeft!.y, 9)
    expect(range(nearLeft!)).toBeLessThan(HAZE_FAR_M)
    expect(range(farRight!)).toBeCloseTo(HAZE_FAR_M, 6)
    expect(range(farLeft!)).toBeCloseTo(HAZE_FAR_M, 6)
    // Wider far than near: a trapezoid opening away from the camera.
    expect(farLeft!.y - farRight!.y).toBeGreaterThan(nearLeft!.y - nearRight!.y)
    expect(footprint.headingRad).toBeCloseTo(0, 9)
  })

  it('clips a far edge that meets the ground beyond the range', () => {
    const camera = orbiting({ distance: 40, elevationDeg: 30, headingDeg: 0 })
    const unclipped = viewFootprint(camera, 0, 1e6)!
    const clipped = viewFootprint(camera, 0, 100)!
    const { apex } = clipped
    const range = (p: { x: number; y: number }) => Math.hypot(p.x - apex.x, p.y - apex.y)
    expect(range(unclipped.polygon[2]!)).toBeGreaterThan(100)
    expect(range(clipped.polygon[2]!)).toBeCloseTo(100, 6)
    // Along the same bearing.
    const bearing = (p: { x: number; y: number }) => Math.atan2(p.y - apex.y, p.x - apex.x)
    expect(bearing(clipped.polygon[2]!)).toBeCloseTo(bearing(unclipped.polygon[2]!), 9)
    expect(clipped.polygon.slice(0, 2)).toEqual(unclipped.polygon.slice(0, 2))
  })

  it('narrows to a triangle from the camera when even the bottom of the view misses the ground', () => {
    // 1 m up, looking 31° above the horizon: the view's bottom edge is 6° above it.
    const target = { x: 100, y: 0, z: 61 }
    const forward = { x: 100, y: 0, z: 60 }
    const length = Math.hypot(forward.x, forward.z)
    const camera: CameraPose = {
      position: { x: 0, y: 0, z: 1 },
      target,
      fovDeg: 50,
      aspect: 1.5,
      up: { x: -forward.z / length, y: 0, z: forward.x / length },
    }
    const footprint = viewFootprint(camera, 0, HAZE_FAR_M)!
    expect(footprint.polygon).toHaveLength(3)
    expect(footprint.polygon[0]).toEqual(footprint.apex)
    for (const p of footprint.polygon.slice(1)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(HAZE_FAR_M, 6)
    }
  })

  it('faces where the camera looks, whatever its heading', () => {
    for (const headingDeg of [0, 90, 135, -60]) {
      const footprint = viewFootprint(
        orbiting({ distance: 20, elevationDeg: 35, headingDeg }),
        0,
        HAZE_FAR_M,
      )!
      const expected = (headingDeg * Math.PI) / 180
      expect(Math.cos(footprint.headingRad)).toBeCloseTo(Math.cos(expected), 9)
      expect(Math.sin(footprint.headingRad)).toBeCloseTo(Math.sin(expected), 9)
      // The footprint lies ahead of the camera.
      const middle = footprint.polygon.reduce(
        (sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }),
        { x: 0, y: 0 },
      )
      const ahead =
        (middle.x - footprint.apex.x) * Math.cos(expected) +
        (middle.y - footprint.apex.y) * Math.sin(expected)
      expect(ahead).toBeGreaterThan(0)
    }
  })

  it('is nothing for a camera at or below the ground', () => {
    const camera = orbiting({ distance: 20, elevationDeg: 35, headingDeg: 0 })
    expect(viewFootprint(camera, camera.position.z, HAZE_FAR_M)).toBeUndefined()
  })
})
