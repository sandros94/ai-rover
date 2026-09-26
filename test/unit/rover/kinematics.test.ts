import { describe, expect, it } from 'vitest'
import { defineWorld } from '#shared/utils/terrain'
import { mulberry32 } from '#shared/utils/terrain/seed'
import type { PlanarPose, ResolvedRoverGeometry, RoverPose } from '#shared/utils/rover'
import {
  checkLimits,
  DEFAULT_ROVER_GEOMETRY,
  defineRoverGeometry,
  poseOnTerrain,
} from '#shared/utils/rover'
import { DEG, roverErrorOf, wheelsFromPose } from './helpers'

const G = DEFAULT_ROVER_GEOMETRY
const r = G.wheelRadius

function ramp(slopeRad: number): (x: number, y: number) => number {
  const t = Math.tan(slopeRad)
  return (x) => t * x
}

/** Contacts lie on the height function and wheel centres sit one radius above them. */
function expectGrounded(
  pose: RoverPose,
  heightAt: (x: number, y: number) => number,
  tolerance = 1e-6,
): void {
  expect(pose.contacts).toHaveLength(6)
  expect(pose.wheels).toHaveLength(6)
  for (const [k, contact] of pose.contacts.entries()) {
    const wheel = pose.wheels[k]!
    expect(Math.abs(contact.z - heightAt(contact.x, contact.y))).toBeLessThan(tolerance)
    expect(wheel.x).toBe(contact.x)
    expect(wheel.y).toBe(contact.y)
    expect(Math.abs(wheel.z - contact.z - r)).toBeLessThan(tolerance)
  }
}

/** The solved angles and quaternion rebuild the same wheel centres. */
function expectConsistent(pose: RoverPose, tolerance = 1e-9): void {
  const rebuilt = wheelsFromPose(pose, G)
  for (const [k, wheel] of pose.wheels.entries()) {
    expect(Math.abs(rebuilt[k]!.x - wheel.x)).toBeLessThan(tolerance)
    expect(Math.abs(rebuilt[k]!.y - wheel.y)).toBeLessThan(tolerance)
    expect(Math.abs(rebuilt[k]!.z - wheel.z)).toBeLessThan(tolerance)
  }
}

describe('poseOnTerrain on flat ground', () => {
  const flat = (): number => 0

  it('stands level at the nominal height', () => {
    const pose = poseOnTerrain(flat, { x: 3, y: -2, headingRad: 0 })
    for (const angle of [
      pose.pitchRad,
      pose.rollRad,
      pose.tiltRad,
      pose.rocker.left,
      pose.rocker.right,
      pose.bogie.left,
      pose.bogie.right,
      pose.differentialRad,
    ]) {
      expect(Math.abs(angle)).toBeLessThan(1e-9)
    }
    expect(pose.position.x).toBe(3)
    expect(pose.position.y).toBe(-2)
    expect(Math.abs(pose.position.z)).toBeLessThan(1e-9)
    for (const contact of pose.contacts) expect(Math.abs(contact.z)).toBeLessThan(1e-12)
    for (const wheel of pose.wheels) expect(wheel.z).toBeCloseTo(r, 9)
    expect(pose.bellyClearanceM).toBeCloseTo(0.6, 9)
    expect(checkLimits(pose)).toEqual({ level: 'ok', reasons: [] })
    expectConsistent(pose)
  })

  it('places the wheels in FL, FR, ML, MR, RL, RR order around the heading', () => {
    const pose = poseOnTerrain(flat, { x: 0, y: 0, headingRad: Math.PI / 2 })
    const expected = [
      [-1.065, 1.185],
      [1.065, 1.185],
      [-1.185, 0],
      [1.185, 0],
      [-1.065, -1.075],
      [1.065, -1.075],
    ]
    for (const [k, [x, y]] of expected.entries()) {
      expect(pose.wheels[k]!.x).toBeCloseTo(x!, 9)
      expect(pose.wheels[k]!.y).toBeCloseTo(y!, 9)
    }
  })

  it('does not depend on the heading', () => {
    const reference = poseOnTerrain(flat, { x: 0, y: 0, headingRad: 0 })
    for (const headingRad of [Math.PI / 3, -2]) {
      const pose = poseOnTerrain(flat, { x: 0, y: 0, headingRad })
      expect(pose.headingRad).toBe(headingRad)
      expect(pose.pitchRad).toBeCloseTo(reference.pitchRad, 9)
      expect(pose.rollRad).toBeCloseTo(reference.rollRad, 9)
      expect(pose.bogie.left).toBeCloseTo(reference.bogie.left, 9)
      expect(pose.rocker.left).toBeCloseTo(reference.rocker.left, 9)
      expect(pose.position.z).toBeCloseTo(reference.position.z, 9)
      expect(pose.bellyClearanceM).toBeCloseTo(reference.bellyClearanceM, 9)
      expectConsistent(pose)
    }
  })
})

describe('poseOnTerrain on a uniform ramp', () => {
  it('pitches nose-up as negative pitch when climbing', () => {
    const heightAt = ramp(10 * DEG)
    const pose = poseOnTerrain(heightAt, { x: 0, y: 0, headingRad: 0 })
    expect(pose.pitchRad).toBeCloseTo(-10 * DEG, 9)
    expect(pose.rollRad).toBeCloseTo(0, 9)
    expect(pose.tiltRad).toBeCloseTo(10 * DEG, 9)
    expect(pose.bogie.left).toBeCloseTo(0, 9)
    expect(pose.rocker.left).toBeCloseTo(0, 9)
    expectGrounded(pose, heightAt, 1e-9)
    expectConsistent(pose)
    // Vertical gap between the tilted belly plane and the ramp, wheel centres one radius above it.
    const c = G.bellyClearance
    const cos = Math.cos(10 * DEG)
    expect(pose.bellyClearanceM).toBeCloseTo(c / cos - r * (1 / cos - 1), 9)
    expect(checkLimits(pose).level).toBe('ok')
  })

  it('rolls left side down as negative roll when the ramp rises to the right', () => {
    const heightAt = ramp(10 * DEG)
    const pose = poseOnTerrain(heightAt, { x: 5, y: 7, headingRad: Math.PI / 2 })
    expect(pose.rollRad).toBeCloseTo(-10 * DEG, 9)
    expect(pose.pitchRad).toBeCloseTo(0, 9)
    expect(pose.differentialRad).toBeCloseTo(0, 9)
    expectGrounded(pose, heightAt, 1e-9)
    expectConsistent(pose)
  })

  it('warns on pitch at 20°', () => {
    const pose = poseOnTerrain(ramp(20 * DEG), { x: 0, y: 0, headingRad: 0 })
    expect(checkLimits(pose)).toEqual({ level: 'warn', reasons: ['pitch'] })
  })

  it('warns on tilt at 35°', () => {
    const pose = poseOnTerrain(ramp(35 * DEG), { x: 0, y: 0, headingRad: 0 })
    const verdict = checkLimits(pose)
    expect(verdict.level).toBe('warn')
    expect(verdict.reasons).toContain('tilt')
  })

  it('fails with tip-over at 50°', () => {
    const heightAt = ramp(50 * DEG)
    const pose = poseOnTerrain(heightAt, { x: 0, y: 0, headingRad: 0 })
    expect(pose.pitchRad).toBeCloseTo(-50 * DEG, 9)
    expectGrounded(pose, heightAt, 1e-9)
    const verdict = checkLimits(pose)
    expect(verdict.level).toBe('fail')
    expect(verdict.reasons).toContain('tip-over')
  })
})

describe('poseOnTerrain over a step under the left rear wheel', () => {
  const heightAt = (x: number, y: number): number => (x < -0.5 && y > 0 ? 0.1 : 0)
  const pose = poseOnTerrain(heightAt, { x: 0, y: 0, headingRad: 0 })

  /** Left bogie angle by eqs. (2), (8), (9), (11) in z-up wheel-centre heights on the flat footprint. */
  function handBogieLeft(g: ResolvedRoverGeometry): number {
    const { links, rockerFlatRad: kd0, bogieFlatRad: kb0, bogiePivot, wheelRadius } = g
    const zf = wheelRadius
    const zm = wheelRadius
    const zr = wheelRadius + 0.1
    const kb = kb0 + Math.asin((zr - zm) / links.middleToRear)
    const zb = zm + links.bogieMiddle * Math.sin(kb)
    const phiF = kd0 - Math.asin((bogiePivot.z - wheelRadius) / links.frontToBogie)
    const kd = phiF + Math.asin((zb - zf) / links.frontToBogie)
    return kd - kb - kd0 + kb0
  }

  it('matches the ACE triangle relations when all wheels share one track', () => {
    // The planar ACE sides assume one lateral offset per side; with it, roll moves the middle
    // and rear wheels alike and the right side stays exactly level.
    const geometry = defineRoverGeometry({ middleWheel: { x: 0, y: 1.065 } })
    const level = poseOnTerrain(heightAt, { x: 0, y: 0, headingRad: 0 }, { geometry })
    const beta = handBogieLeft(geometry)
    expect(beta).toBeLessThan(0)
    expect(Math.abs(level.bogie.left - beta)).toBeLessThan(1e-5)
    expect(Math.abs(level.bogie.right)).toBeLessThan(1e-12)
  })

  it('turns the left bogie negative when its rear wheel climbs', () => {
    // The wider middle track lets body roll lift ML more than RL, a 1.5 mrad departure from ACE.
    expect(pose.bogie.left).toBeLessThan(0)
    expect(Math.abs(pose.bogie.left - handBogieLeft(G))).toBeLessThan(2e-3)
  })

  it('leaves the right bogie nearly level and turns the differential', () => {
    expect(Math.abs(pose.bogie.right)).toBeLessThan(0.025 * Math.abs(pose.bogie.left))
    expect(Math.abs(pose.differentialRad)).toBeGreaterThan(1e-3)
    expect(pose.rocker.right).toBe(-pose.rocker.left)
  })

  it('keeps every wheel on the ground', () => {
    expectGrounded(pose, heightAt, 1e-9)
    expectConsistent(pose)
    expect(pose.contacts[4]!.z).toBe(0.1)
  })
})

describe('poseOnTerrain ground contact over a generated world', () => {
  const world = defineWorld({ seed: 'mars' })
  const random = mulberry32(0x5eed)
  const poses: PlanarPose[] = []
  for (let k = 0; k < 200; k++) {
    const radius = 300 * Math.sqrt(random())
    const angle = 2 * Math.PI * random()
    poses.push({
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      headingRad: 2 * Math.PI * random() - Math.PI,
    })
  }

  it('grounds every wheel at 200 random poses', () => {
    const solved = poses.map((planar) => poseOnTerrain(world.heightAt, planar))
    for (const pose of solved) {
      expectGrounded(pose, world.heightAt)
      expectConsistent(pose, 1e-6)
    }
    expect(solved).toHaveLength(200)
  })

  it('grounds every wheel at re-solved poses between neighbours, where lerped heights do not', () => {
    let worstLerpError = 0
    for (const a of poses) {
      const b: PlanarPose = {
        x: a.x + 0.5 * Math.cos(a.headingRad),
        y: a.y + 0.5 * Math.sin(a.headingRad),
        headingRad: a.headingRad + 0.05,
      }
      const poseA = poseOnTerrain(world.heightAt, a)
      const poseB = poseOnTerrain(world.heightAt, b)
      for (const t of [0.25, 0.5, 0.75]) {
        const between = poseOnTerrain(world.heightAt, {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          headingRad: a.headingRad + (b.headingRad - a.headingRad) * t,
        })
        expectGrounded(between, world.heightAt)
        for (let k = 0; k < 6; k++) {
          const cA = poseA.contacts[k]!
          const cB = poseB.contacts[k]!
          const x = cA.x + (cB.x - cA.x) * t
          const y = cA.y + (cB.y - cA.y) * t
          const z = cA.z + (cB.z - cA.z) * t
          worstLerpError = Math.max(worstLerpError, Math.abs(z - world.heightAt(x, y)))
        }
      }
    }
    expect(worstLerpError).toBeGreaterThan(1e-6)
  })
})

describe('poseOnTerrain errors and determinism', () => {
  it('refuses an impossible step with NO_CONTACT naming the wheels', () => {
    const heightAt = (x: number, y: number): number => (x < -0.5 && y > 0 ? 1.5 : 0)
    const error = roverErrorOf(() => poseOnTerrain(heightAt, { x: 0, y: 0, headingRad: 0 }))
    expect(error?.code).toBe('NO_CONTACT')
    expect(error?.message).toMatch(/RL/)
  })

  it('refuses a non-finite pose', () => {
    for (const pose of [
      { x: Number.NaN, y: 0, headingRad: 0 },
      { x: 0, y: Infinity, headingRad: 0 },
      { x: 0, y: 0, headingRad: Number.NaN },
    ]) {
      expect(roverErrorOf(() => poseOnTerrain(() => 0, pose))?.code).toBe('INVALID_POSE')
    }
  })

  it('refuses a height function that returns a non-finite height', () => {
    const error = roverErrorOf(() => poseOnTerrain(() => Number.NaN, { x: 0, y: 0, headingRad: 0 }))
    expect(error?.code).toBe('INVALID_POSE')
  })

  it('uses the geometry passed in', () => {
    const geometry = defineRoverGeometry({ wheelRadius: 0.3 })
    const pose = poseOnTerrain(() => 0, { x: 0, y: 0, headingRad: 0 }, { geometry })
    for (const wheel of pose.wheels) expect(wheel.z).toBeCloseTo(0.3, 9)
  })

  it('returns identical objects for identical calls', () => {
    const world = defineWorld({ seed: 'mars' })
    const planar = { x: 12.3, y: -45.6, headingRad: 0.7 }
    expect(poseOnTerrain(world.heightAt, planar)).toEqual(poseOnTerrain(world.heightAt, planar))
  })
})
