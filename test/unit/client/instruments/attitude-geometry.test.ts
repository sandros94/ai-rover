import { describe, expect, it } from 'vitest'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import { DEFAULT_ROVER_GEOMETRY as G, DEFAULT_ROVER_LIMITS } from '#shared/utils/rover'
import {
  attitudeLevels,
  frameAttitude,
  roverLinkage,
  sideView,
} from '#shared/utils/client/instruments/attitude-geometry'

const DEG = Math.PI / 180
const FLAT = {
  pitchRad: 0,
  rollRad: 0,
  rocker: { left: 0, right: 0 },
  bogie: { left: 0, right: 0 },
}

/** A keyframe at the given attitude, the quaternion built as `Rz(heading) · Ry(pitch) · Rx(roll)`. */
function frame(
  values: Partial<Record<(typeof KEYFRAME_FIELDS)[number], number>> & {
    heading?: number
    pitch?: number
    roll?: number
  },
): Float32Array {
  const { heading = 0, pitch = 0, roll = 0 } = values
  const [ch, sh] = [Math.cos(heading / 2), Math.sin(heading / 2)]
  const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)]
  const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)]
  const out = new Float32Array(KEYFRAME_STRIDE)
  const set = (name: (typeof KEYFRAME_FIELDS)[number], v: number) => {
    out[KEYFRAME_FIELDS.indexOf(name)] = v
  }
  set('qx', sr * cp * ch - cr * sp * sh)
  set('qy', cr * sp * ch + sr * cp * sh)
  set('qz', cr * cp * sh - sr * sp * ch)
  set('qw', cr * cp * ch + sr * sp * sh)
  for (const [name, v] of Object.entries(values)) {
    if ((KEYFRAME_FIELDS as readonly string[]).includes(name))
      set(name as (typeof KEYFRAME_FIELDS)[number], v)
  }
  return out
}

describe('frameAttitude', () => {
  it('reads pitch, roll and tilt independently of heading', () => {
    const a = frameAttitude(frame({ heading: 2.1, pitch: 8 * DEG, roll: -5 * DEG }))
    expect(a.pitchRad).toBeCloseTo(8 * DEG, 5)
    expect(a.rollRad).toBeCloseTo(-5 * DEG, 5)
    expect(a.tiltRad).toBeCloseTo(Math.acos(Math.cos(8 * DEG) * Math.cos(5 * DEG)), 5)
  })

  it('reads the suspension angles and wheel spins by name', () => {
    const a = frameAttitude(
      frame({ rockerL: 0.05, rockerR: -0.05, bogieL: 0.1, bogieR: -0.2, spinFL: 1, spinRR: 6 }),
    )
    expect(a.rocker.left).toBeCloseTo(0.05, 6)
    expect(a.rocker.right).toBeCloseTo(-0.05, 6)
    expect(a.differentialRad).toBeCloseTo(0.05, 6)
    expect(a.bogie).toEqual({ left: expect.closeTo(0.1, 6), right: expect.closeTo(-0.2, 6) })
    expect(a.spins).toHaveLength(6)
    expect(a.spins[0]).toBe(1)
    expect(a.spins[5]).toBe(6)
  })
})

describe('roverLinkage', () => {
  it('puts every joint at the resolved geometry on a flat pose', () => {
    const l = roverLinkage(FLAT)
    const r = G.wheelRadius
    const expected = [
      [G.frontWheel.x, G.frontWheel.y],
      [G.frontWheel.x, -G.frontWheel.y],
      [G.middleWheel.x, G.middleWheel.y],
      [G.middleWheel.x, -G.middleWheel.y],
      [G.rearWheel.x, G.rearWheel.y],
      [G.rearWheel.x, -G.rearWheel.y],
    ]
    expect(l.wheels).toHaveLength(6)
    l.wheels.forEach((w, k) => {
      expect(w.x).toBeCloseTo(expected[k]![0]!, 12)
      expect(w.y).toBeCloseTo(expected[k]![1]!, 12)
      expect(w.z).toBeCloseTo(r, 12)
    })
    for (const p of l.rockerPivots) {
      expect(p.x).toBeCloseTo(G.rockerPivot.x, 12)
      expect(p.z).toBeCloseTo(G.rockerPivot.z, 12)
    }
    for (const p of l.bogiePivots) {
      expect(p.x).toBeCloseTo(G.bogiePivot.x, 12)
      expect(p.z).toBeCloseTo(G.bogiePivot.z, 12)
    }
  })

  it('keeps the link lengths under any articulation', () => {
    const l = roverLinkage({
      ...FLAT,
      rocker: { left: 0.1, right: -0.1 },
      bogie: { left: 0.2, right: -0.15 },
    })
    const d = (a: { x: number; z: number }, b: { x: number; z: number }) =>
      Math.hypot(a.x - b.x, a.z - b.z)
    expect(d(l.wheels[0]!, l.rockerPivots[0]!)).toBeCloseTo(G.links.rockerFront, 10)
    expect(d(l.bogiePivots[1]!, l.rockerPivots[1]!)).toBeCloseTo(G.links.rockerBogie, 10)
    expect(d(l.wheels[2]!, l.bogiePivots[0]!)).toBeCloseTo(G.links.bogieMiddle, 10)
    expect(d(l.wheels[5]!, l.bogiePivots[1]!)).toBeCloseTo(G.links.bogieRear, 10)
  })

  it('turns the front wheel and bogie pivot about the rocker pivot, nose up for a positive rocker', () => {
    const l = roverLinkage({ ...FLAT, rocker: { left: 0.1, right: -0.1 } })
    expect(l.wheels[0]!.z).toBeGreaterThan(G.wheelRadius)
    expect(l.wheels[1]!.z).toBeLessThan(G.wheelRadius)
    expect(l.bogiePivots[0]!.z).toBeLessThan(G.bogiePivot.z)
    expect(l.rockerPivots[0]!.z).toBeCloseTo(G.rockerPivot.z, 12)
  })

  it('moves only the middle and rear wheels with the bogie', () => {
    const flat = roverLinkage(FLAT)
    const l = roverLinkage({ ...FLAT, bogie: { left: 0.2, right: 0 } })
    expect(l.wheels[0]).toEqual(flat.wheels[0])
    expect(l.bogiePivots[0]).toEqual(flat.bogiePivots[0])
    expect(l.wheels[2]!.z).toBeGreaterThan(G.wheelRadius)
    expect(l.wheels[4]!.z).toBeLessThan(G.wheelRadius)
    expect(l.wheels[3]).toEqual(flat.wheels[3])
  })

  it('lowers the nose for positive pitch and raises the left side for positive roll', () => {
    const pitched = roverLinkage({ ...FLAT, pitchRad: 10 * DEG })
    expect(pitched.wheels[0]!.z).toBeLessThan(pitched.wheels[4]!.z)
    const rolled = roverLinkage({ ...FLAT, rollRad: 10 * DEG })
    expect(rolled.wheels[2]!.z).toBeGreaterThan(rolled.wheels[3]!.z)
  })
})

describe('sideView', () => {
  const flat = sideView(frameAttitude(frame({})))
  const view = (values: Parameters<typeof frame>[0]) => sideView(frameAttitude(frame(values)))

  it('draws the right side near and the left side far at the resolved geometry', () => {
    const l = roverLinkage(FLAT)
    expect(flat.near.wheels.map((w) => w.center)).toEqual([l.wheels[1], l.wheels[3], l.wheels[5]])
    expect(flat.near.rocker).toEqual([l.wheels[1], l.rockerPivots[1], l.bogiePivots[1]])
    expect(flat.near.bogie).toEqual([l.wheels[3], l.bogiePivots[1], l.wheels[5]])
    expect(flat.far.wheels.map((w) => w.center)).toEqual([l.wheels[0], l.wheels[2], l.wheels[4]])
  })

  it('articulates the near side with the right bogie, not the left', () => {
    const right = view({ bogieR: 10 * DEG, bogieL: 0 }).near
    expect(right.wheels[1]!.center.z).toBeGreaterThan(G.wheelRadius)
    expect(right.wheels[2]!.center.z).toBeLessThan(G.wheelRadius)
    const left = view({ bogieL: 10 * DEG, bogieR: 0 })
    expect(left.near).toEqual(flat.near)
    expect(left.far.wheels[1]!.center.z).toBeGreaterThan(G.wheelRadius)
  })

  it('articulates the near side with the right rocker, not the left', () => {
    expect(view({ rockerR: 10 * DEG, rockerL: 0 }).near.wheels[0]!.center.z).toBeGreaterThan(
      G.wheelRadius,
    )
    expect(view({ rockerL: 10 * DEG, rockerR: 0 }).near).toEqual(flat.near)
  })

  it('turns the wheels of each side with the spins of that side', () => {
    const v = view({ spinFL: 1, spinFR: 2, spinML: 3, spinMR: 4, spinRL: 5, spinRR: 6 })
    expect(v.near.wheels.map((w) => w.spin)).toEqual([2, 4, 6])
    expect(v.far.wheels.map((w) => w.spin)).toEqual([1, 3, 5])
  })
})

describe('attitudeLevels', () => {
  const at = (values: Parameters<typeof frame>[0]) => attitudeLevels(frameAttitude(frame(values)))

  it('is ok on a flat pose', () => {
    expect(Object.values(at({})).every((level) => level === 'ok')).toBe(true)
  })

  it('warns past the flight limits', () => {
    const levels = at({ pitch: 16 * DEG, rockerL: 8 * DEG, rockerR: -8 * DEG, bogieR: 18 * DEG })
    expect(levels.pitch).toBe('warn')
    expect(levels.differential).toBe('warn')
    expect(levels.bogieRight).toBe('warn')
    expect(levels.bogieLeft).toBe('ok')
    expect(levels.roll).toBe('ok')
  })

  it('fails past the tip-over tilt', () => {
    const levels = at({ roll: 46 * DEG })
    expect(levels.tilt).toBe('fail')
    expect(levels.roll).toBe('fail')
    expect(DEFAULT_ROVER_LIMITS.tipOverRad).toBeCloseTo(45 * DEG, 12)
  })
})
