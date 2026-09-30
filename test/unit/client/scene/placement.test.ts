import { describe, expect, it } from 'vitest'
import type { Point3 } from '#shared/utils/rover'
import { frameAttitude } from '#shared/utils/client/instruments/attitude-geometry'
import type { Quat } from '#shared/utils/client/scene/placement'
import { flatFrame, framePlacement, fromTo } from '#shared/utils/client/scene/placement'

function rotate(q: Quat, p: Point3): Point3 {
  // p + 2w(v × p) + 2 v × (v × p)
  const tx = 2 * (q.y * p.z - q.z * p.y)
  const ty = 2 * (q.z * p.x - q.x * p.z)
  const tz = 2 * (q.x * p.y - q.y * p.x)
  return {
    x: p.x + q.w * tx + (q.y * tz - q.z * ty),
    y: p.y + q.w * ty + (q.z * tx - q.x * tz),
    z: p.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

describe('flatFrame', () => {
  it('places an unarticulated rover at a point and heading', () => {
    const frame = flatFrame({ x: 5, y: 6, z: 7, headingRad: Math.PI / 2 })
    const { position, quaternion } = framePlacement(frame)
    expect(position).toEqual({ x: 5, y: 6, z: 7 })
    const forward = rotate(quaternion, { x: 1, y: 0, z: 0 })
    expect(forward.x).toBeCloseTo(0, 6)
    expect(forward.y).toBeCloseTo(1, 6)
    const attitude = frameAttitude(frame)
    expect(attitude.rocker).toEqual({ left: 0, right: 0 })
  })
})

describe('fromTo', () => {
  it('turns one unit vector onto another, opposite ones included', () => {
    const cases: [Point3, Point3][] = [
      [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0.6, z: 0.8 },
      ],
      [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: -1, z: 0 },
      ],
    ]
    for (const [a, b] of cases) {
      const turned = rotate(fromTo(a, b), a)
      expect(turned.x).toBeCloseTo(b.x, 9)
      expect(turned.y).toBeCloseTo(b.y, 9)
      expect(turned.z).toBeCloseTo(b.z, 9)
    }
  })
})
