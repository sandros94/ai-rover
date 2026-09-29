import { describe, expect, it } from 'vitest'
import type { DriveEvent } from '#shared/utils/drive'
import {
  DEFAULT_SPEED_MODEL,
  driveLimits,
  driveSegment,
  interpolatePose,
  rampDurationS,
} from '#shared/utils/drive'
import { AUTONAV_EFFECTIVE_MPS, DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import { F, frame, revealedAfterStop, syntheticDisk, syntheticWorld, yawOf } from './helpers'

const {
  accelMps2,
  turnRateRadPerS,
  turnAccelRadPerS2,
  steerRateRadPerS,
  steerAccelRadPerS2,
  emergencyDecelMps2,
} = DEFAULT_SPEED_MODEL
const cruise = AUTONAV_EFFECTIVE_MPS
const rampS = rampDurationS(0, cruise, driveLimits(cruise))
/** Float32 frames round their values; bounds on differences allow this much. */
const EPS = 1e-6

describe('a drive on its motion profiles', () => {
  const world = syntheticWorld({})
  const disk = syntheticDisk(world)
  // A quarter turn right, then 30 m east with an imaging stop every 10 m: steering, a turn in
  // place, starts and stops.
  const { record } = driveSegment(world, {
    disk,
    revealed: revealedAfterStop(world, disk),
    start: { x: 0, y: 0, headingRad: Math.PI / 2 },
    goal: { x: 30, y: 0 },
    stops: { imagingEveryM: 10 },
  })
  const { keyframes, events } = record
  const { hz, count } = keyframes
  const speeds = Array.from({ length: count }, (_, k) => frame(keyframes, k)[F.speed]!)
  const of = (type: DriveEvent['type']) => events.filter((event) => event.type === type)

  it('arrives after steering, turning, and two imaging stops', () => {
    expect(record.outcome.kind).toBe('arrived')
    expect(of('turning')).toHaveLength(1)
    expect(of('steering')).toHaveLength(2)
    expect(of('imaging')).toHaveLength(2)
  })

  it('never changes speed between frames faster than the acceleration allows', () => {
    let largest = 0
    for (let k = 1; k < count; k++)
      largest = Math.max(largest, Math.abs(speeds[k]! - speeds[k - 1]!))
    expect(largest).toBeLessThanOrEqual(accelMps2 / hz + EPS)
    // The ramps are there to see: a step of half a second changes the speed by about 0.01 m/s.
    expect(largest).toBeGreaterThan(0.5 * (accelMps2 / hz))
    expect(Math.max(...speeds)).toBeLessThanOrEqual(cruise + EPS)
  })

  it('rises from rest to cruise over the ramp each time it drives off', () => {
    // After steering out of the turn, and after each imaging stop.
    const offs = [...of('steering').slice(1), ...of('imaging')].map(
      (event) => event.t + (event.details!.durationS as number),
    )
    for (const off of offs) {
      const k = Math.ceil(off * hz)
      expect(speeds[k - 1]).toBe(0)
      const ramp: number[] = []
      for (let j = k; speeds[j]! < cruise - EPS; j++) ramp.push(speeds[j]!)
      // Rising on every frame, over about 2 s.
      for (let j = 1; j < ramp.length; j++) expect(ramp[j]).toBeGreaterThan(ramp[j - 1]!)
      expect(ramp.length / hz).toBeGreaterThanOrEqual(rampS - 1 / hz)
      expect(ramp.length / hz).toBeLessThanOrEqual(rampS + 1 / hz)
    }
  })

  it('falls back to rest before every stop it drives into', () => {
    // Each stop the rover drives into: the two imaging stops and the arrival.
    const stops = [...of('imaging'), ...of('arrived')]
    expect(stops.length).toBe(3)
    for (const stop of stops) {
      const k = Math.ceil(stop.t * hz - 1e-9)
      expect(speeds[k]).toBe(0)
      // Falling on every frame of the ramp down, from cruise.
      // The rover may have come to rest a frame before the stop starts.
      let j = k - 1
      while (speeds[j] === 0) j--
      expect(k - j).toBeLessThanOrEqual(2)
      const fall: number[] = []
      while (speeds[j]! < cruise - EPS) fall.unshift(speeds[j--]!)
      for (let m = 1; m < fall.length; m++) expect(fall[m]).toBeLessThan(fall[m - 1]!)
      expect(fall.length / hz).toBeGreaterThanOrEqual(rampS - 1 / hz)
    }
  })

  it('ramps the point turn up to the turn rate and back down', () => {
    const turning = of('turning')[0]!
    const from = Math.ceil(turning.t * hz)
    const to = Math.floor((turning.t + (turning.details!.durationS as number)) * hz)
    const yaw = (k: number) => {
      const f = frame(keyframes, k)
      return yawOf({ x: f[F.qx]!, y: f[F.qy]!, z: f[F.qz]!, w: f[F.qw]! })
    }
    const rates: number[] = []
    for (let k = from; k <= to; k++) rates.push(Math.abs(yaw(k + 1) - yaw(k)) * hz)
    expect(Math.max(...rates)).toBeLessThanOrEqual(turnRateRadPerS + EPS)
    expect(Math.max(...rates)).toBeGreaterThan(turnRateRadPerS - EPS)
    // It starts and ends slow, and the rate never changes faster than the angular acceleration.
    expect(rates[0]).toBeLessThan(0.5 * turnRateRadPerS)
    expect(rates.at(-1)).toBeLessThan(0.5 * turnRateRadPerS)
    for (let k = 1; k < rates.length; k++) {
      expect(Math.abs(rates[k]! - rates[k - 1]!)).toBeLessThanOrEqual(turnAccelRadPerS2 / hz + EPS)
    }
  })

  it('ramps each steering joint up to the steering rate and back down', () => {
    for (const steering of of('steering')) {
      const from = Math.floor(steering.t * hz)
      const to = Math.ceil((steering.t + (steering.details!.durationS as number)) * hz)
      const rates: number[] = []
      for (let k = from; k < to; k++) {
        rates.push(
          Math.abs(frame(keyframes, k + 1)[F.steerFL]! - frame(keyframes, k)[F.steerFL]!) * hz,
        )
      }
      expect(Math.max(...rates)).toBeLessThanOrEqual(steerRateRadPerS + EPS)
      expect(rates[0]).toBeLessThan(0.5 * steerRateRadPerS)
      expect(rates.at(-1)).toBeLessThan(0.5 * steerRateRadPerS)
      for (let k = 1; k < rates.length; k++) {
        expect(Math.abs(rates[k]! - rates[k - 1]!)).toBeLessThanOrEqual(
          steerAccelRadPerS2 / hz + EPS,
        )
      }
    }
  })

  describe('interpolated at 60 Hz', () => {
    const h = 1 / 60
    const at = (t: number) => interpolatePose(keyframes, t)
    const velocity = (t0: number, t1: number): [number, number] => {
      const a = at(t0)
      const b = at(t1)
      return [(b[F.x]! - a[F.x]!) / (t1 - t0), (b[F.y]! - a[F.y]!) / (t1 - t0)]
    }
    const heading = (t: number) => {
      const f = at(t)
      return yawOf({ x: f[F.qx]!, y: f[F.qy]!, z: f[F.qz]!, w: f[F.qw]! })
    }
    const last = frame(keyframes, count - 1)[F.t]!

    it('keeps the velocity continuous across frame boundaries, where linear frames kink', () => {
      let jump = 0
      let kink = 0
      for (let k = 1; k < count - 1; k++) {
        const t = k / hz
        const [lx, ly] = velocity(t - h, t)
        const [rx, ry] = velocity(t, t + h)
        jump = Math.max(jump, Math.hypot(rx - lx, ry - ly))
        const p = [k - 1, k, k + 1].map((j) => frame(keyframes, j))
        const secant = (a: Float32Array, b: Float32Array) =>
          [(b[F.x]! - a[F.x]!) * hz, (b[F.y]! - a[F.y]!) * hz] as const
        const [ax, ay] = secant(p[0]!, p[1]!)
        const [bx, by] = secant(p[1]!, p[2]!)
        kink = Math.max(kink, Math.hypot(bx - ax, by - ay))
      }
      // Over 2 × 1/60 s the acceleration changes the velocity by at most 2 A h; float32
      // positions add about 1e-4 m/s to a finite difference.
      expect(jump).toBeLessThan(2 * accelMps2 * h + 5e-4)
      expect(kink).toBeGreaterThan(5 * jump)
    })

    it('reports the speed of the interpolated motion', () => {
      for (let t = 0.3; t < last; t += 7.3) {
        const [vx, vy] = velocity(t - h / 2, t + h / 2)
        expect(Math.abs(at(t)[F.speed]! - Math.hypot(vx, vy))).toBeLessThan(5e-4)
      }
    })

    it('keeps the heading rate continuous through the turn', () => {
      const turning = of('turning')[0]!
      const end = turning.t + (turning.details!.durationS as number)
      let jump = 0
      for (let k = Math.ceil(turning.t * hz); k < end * hz; k++) {
        const t = k / hz
        const left = (heading(t) - heading(t - h)) / h
        const right = (heading(t + h) - heading(t)) / h
        jump = Math.max(jump, Math.abs(right - left))
      }
      expect(jump).toBeLessThan(2 * turnAccelRadPerS2 * h + 1e-4)
    })

    it('rolls the wheels as far as the rover moves', () => {
      const r = DEFAULT_ROVER_GEOMETRY.wheelRadius
      // Driving east along y = 0 after the turn: x is the distance.
      const off = of('steering')[1]!
      const t0 = Math.ceil((off.t + (off.details!.durationS as number)) * hz) / hz
      const from = at(t0)
      for (let t = t0 + h; t < t0 + 20; t += h) {
        const f = at(t)
        const rolled = (f[F.spinML]! - from[F.spinML]!) * r
        expect(Math.abs(rolled - (f[F.x]! - from[F.x]!))).toBeLessThan(1e-4)
      }
    })

    it('stays exactly still while the rover stands', () => {
      const imaging = of('imaging')[0]!
      const a = at(imaging.t + 0.1)
      for (let t = imaging.t + 0.1; t < imaging.t + 29.9; t += 1.3) {
        const f = at(t)
        for (const k of [F.x, F.y, F.qz, F.spinML]) expect(f[k]).toBe(a[k])
        expect(f[F.speed]).toBe(0)
      }
    })
  })
})

describe('a drive that gets stuck', () => {
  const tan14 = Math.tan((14 * Math.PI) / 180)
  const world = syntheticWorld({ heightAt: (x) => tan14 * x, looseAt: () => 1 })
  const disk = syntheticDisk(world)
  const { record } = driveSegment(world, {
    disk,
    revealed: revealedAfterStop(world, disk),
    start: { x: 0, y: 0, headingRad: 0 },
    goal: { x: 40, y: 0 },
  })

  it('brakes to rest at the emergency deceleration, faster than a stop', () => {
    const stuck = record.events.find((event) => event.type === 'stuck')!
    expect(stuck).toBeDefined()
    const { keyframes } = record
    // Commanded at up to cruise speed: at rest within cruise / emergency deceleration.
    const settled = Math.ceil((stuck.t + cruise / emergencyDecelMps2) * keyframes.hz)
    const rest = frame(keyframes, settled)
    expect(rest[F.speed]).toBe(0)
    for (let k = settled; k < keyframes.count; k++) {
      expect(frame(keyframes, k)[F.spinML]).toBe(rest[F.spinML])
    }
    expect(cruise / emergencyDecelMps2).toBeLessThan(rampS / 4)
  })
})
