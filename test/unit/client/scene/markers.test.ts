import { describe, expect, it } from 'vitest'
import type { Point3 } from '#shared/utils/rover'
import type { Quat } from '#shared/utils/client/scene/placement'
import {
  ARRIVAL_RADIUS_M,
  FLAG_CANT_RAD,
  FLAG_MARKERS,
  flagYaw,
  routeApproach,
  routeDestination,
  STOP_MARKER,
  stopMarkerInstances,
} from '#shared/utils/client/scene/markers'

/** `v` turned by unit quaternion `q`. */
function rotate(q: Quat, v: Point3): Point3 {
  const { x, y, z, w } = q
  const tx = 2 * (y * v.z - z * v.y)
  const ty = 2 * (z * v.x - x * v.z)
  const tz = 2 * (x * v.y - y * v.x)
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  }
}

describe('STOP_MARKER', () => {
  it('is a thin post 1.6 m tall topped by a small sphere', () => {
    expect(STOP_MARKER.postRadiusM).toBeCloseTo(0.04)
    expect(STOP_MARKER.postHeightM).toBeCloseTo(1.6)
    expect(STOP_MARKER.sphereRadiusM).toBeCloseTo(0.12)
  })

  it('seats the sphere on the post top and the band just under the sphere', () => {
    const { postHeightM, sphereRadiusM, headZ, bandZ, bandHeightM, bandRadiusM, topZ } = STOP_MARKER
    // The sphere sinks onto the post's top without swallowing it past its centre.
    expect(headZ - sphereRadiusM).toBeLessThan(postHeightM)
    expect(headZ).toBeGreaterThan(postHeightM)
    expect(topZ).toBeCloseTo(headZ + sphereRadiusM)
    // The band is wider than the post, below the sphere, on the post.
    expect(bandRadiusM).toBeGreaterThan(STOP_MARKER.postRadiusM)
    expect(bandZ + bandHeightM / 2).toBeLessThanOrEqual(headZ - sphereRadiusM)
    expect(bandZ - bandHeightM / 2).toBeGreaterThan(postHeightM / 2)
  })
})

describe('stopMarkerInstances', () => {
  const stops = [
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: -4, y: 2, current: true },
  ]

  it('stands one marker on the ground at each stop, the current one flagged', () => {
    const instances = stopMarkerInstances(stops, (x, y) => 100 + 0.1 * x + 0.2 * y)
    expect(instances).toHaveLength(3)
    instances.forEach((instance, k) => {
      const stop = stops[k]!
      expect(instance.base.x).toBe(stop.x)
      expect(instance.base.y).toBe(stop.y)
      expect(instance.base.z).toBeCloseTo(100 + 0.1 * stop.x + 0.2 * stop.y, 9)
    })
    expect(instances.map((i) => i.current)).toEqual([false, false, true])
  })

  it('lays the contact disc on the ground slope while the post stays upright', () => {
    const [instance] = stopMarkerInstances([{ x: 3, y: 4 }], (x, y) => 0.5 * x - 0.25 * y)
    const n = { x: -0.5, y: 0.25, z: 1 }
    const length = Math.hypot(n.x, n.y, n.z)
    const up = rotate(instance!.contact, { x: 0, y: 0, z: 1 })
    expect(up.x).toBeCloseTo(n.x / length, 6)
    expect(up.y).toBeCloseTo(n.y / length, 6)
    expect(up.z).toBeCloseTo(n.z / length, 6)
  })

  it('stands on flat ground at 0 where no ground is loaded', () => {
    const [instance] = stopMarkerInstances([{ x: 1, y: 1 }], () => undefined)
    expect(instance!.base).toEqual({ x: 1, y: 1, z: 0 })
    const up = rotate(instance!.contact, { x: 0, y: 0, z: 1 })
    expect([up.x, up.y, up.z].map((c) => c + 0)).toEqual([0, 0, 1])
  })
})

describe('flagYaw', () => {
  const at = { x: 20, y: -5 }
  const cloth = (yaw: number) => ({ x: Math.cos(yaw), y: Math.sin(yaw) })

  for (const from of [
    { x: 0, y: 0 },
    { x: 20, y: 30 },
    { x: 45, y: -5 },
    { x: 18, y: -40 },
  ]) {
    it(`shows its face to the side it is seen from (${from.x}, ${from.y})`, () => {
      const e = cloth(flagYaw(at, from))
      const d = Math.hypot(from.x - at.x, from.y - at.y)
      const toViewer = { x: (from.x - at.x) / d, y: (from.y - at.y) / d }
      // The cloth's normal is the extent turned a quarter; its facing is the cosine to the viewer.
      const facing = Math.abs(-e.y * toViewer.x + e.x * toViewer.y)
      expect(facing).toBeCloseTo(Math.cos(FLAG_CANT_RAD), 9)
      expect(facing).toBeGreaterThan(0.85)
      // Seen square from the side it is not edge-on: the cant shows a sliver of face.
      const side = Math.abs(e.x * toViewer.x + e.y * toViewer.y)
      expect(side).toBeCloseTo(Math.sin(FLAG_CANT_RAD), 9)
      expect(side).toBeGreaterThan(0.3)
    })
  }

  it('faces south when seen from where it stands', () => {
    const e = cloth(flagYaw(at, at))
    // Seen from the south, the cloth's normal is its extent turned a quarter: (-e.y, e.x).
    expect(Math.abs(e.x)).toBeCloseTo(Math.cos(FLAG_CANT_RAD), 9)
  })

  it('keeps the destination flag larger than a goal flag', () => {
    const { destination, goal } = FLAG_MARKERS
    expect(destination.poleHeightM).toBeGreaterThan(goal.poleHeightM)
    expect(destination.clothWidthM).toBeGreaterThan(goal.clothWidthM)
    expect(destination.clothHeightM).toBeGreaterThan(goal.clothHeightM)
    expect(destination.clothWidthM).toBeGreaterThan(destination.clothHeightM)
  })
})

describe('routeApproach', () => {
  const route = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 4 },
  ]

  it('is the point the given distance back along the route from its end', () => {
    expect(routeApproach(route, 10)).toEqual({ x: 24, y: 0 })
    expect(routeApproach(route, 2)).toEqual({ x: 30, y: 2 })
  })

  it('is the route start on a route shorter than the distance', () => {
    expect(routeApproach(route, 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('routeDestination', () => {
  const route = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 40 },
  ]

  it("is the route's last point", () => {
    expect(routeDestination(route, [{ x: 0, y: 0 }])).toEqual({ x: 30, y: 40 })
  })

  it('is none without a route', () => {
    expect(routeDestination([], [])).toBeNull()
    expect(routeDestination([{ x: 1, y: 1 }], [])).toBeNull()
  })

  it('gives way to the stop an arrival leaves there', () => {
    const near = { x: 30 + 0.8 * ARRIVAL_RADIUS_M, y: 40 }
    const far = { x: 30 + 1.2 * ARRIVAL_RADIUS_M, y: 40 }
    expect(routeDestination(route, [{ x: 0, y: 0 }, near])).toBeNull()
    expect(routeDestination(route, [{ x: 0, y: 0 }, far])).toEqual({ x: 30, y: 40 })
  })
})
