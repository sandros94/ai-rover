import { RoverError } from './errors'
import type { ResolvedRoverGeometry } from './geometry'
import { DEFAULT_ROVER_GEOMETRY } from './geometry'

/** A planar pose in world metres: x east, y north, heading counter-clockwise from +x. */
export interface PlanarPose {
  x: number
  y: number
  headingRad: number
}

export interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * A rover standing on the ground. Body frame x forward, y left, z up; the attitude is the
 * intrinsic z-y-x rotation (heading, then pitch, then roll), each right-handed about its body
 * axis: positive pitch lowers the nose, positive roll raises the left side. Suspension angles
 * are nose-up rotations: `rocker` of each rocker relative to the body (left = −right, the
 * differential), `bogie` of each bogie relative to its rocker (positive when the middle wheel
 * rises or the rear wheel drops).
 */
export interface RoverPose {
  /** Body origin (middle axle on the contact plane of flat ground) in world metres. */
  position: Point3
  headingRad: number
  pitchRad: number
  rollRad: number
  /** Angle between body z and world up. */
  tiltRad: number
  /** World-from-body rotation, `Rz(heading) · Ry(pitch) · Rx(roll)`. */
  quaternion: { x: number; y: number; z: number; w: number }
  /** Wheel centres in world metres, order FL, FR, ML, MR, RL, RR. */
  wheels: Point3[]
  /** Ground contact under each wheel centre, same order; each lies one radius below its wheel along world z. */
  contacts: Point3[]
  rocker: { left: number; right: number }
  bogie: { left: number; right: number }
  /** The left rocker angle; the differential turns the rockers equal and opposite. */
  differentialRad: number
  /** Least vertical gap between the belly-pan plane and the ground under its footprint; negative when ground pierces it. */
  bellyClearanceM: number
}

export interface PoseOnTerrainOptions {
  geometry?: ResolvedRoverGeometry
}

const WHEEL_NAMES = ['FL', 'FR', 'ML', 'MR', 'RL', 'RR'] as const

/** Largest wheel-height residual accepted as contact, metres. */
const CONTACT_TOLERANCE_M = 1e-10
const MAX_ITERATIONS = 30
const MAX_STEP_HALVINGS = 12
/** Finite-difference steps: terrain gradient in metres, linkage derivatives in radians. */
const GRADIENT_STEP_M = 1e-3
const ANGLE_STEP_RAD = 1e-6
/** Belly-pan footprint sample spacing, metres. */
const BELLY_SAMPLE_M = 0.25

/**
 * Stands the rover on `heightAt` at a planar pose. The six degrees of freedom left by the
 * planar pose (body height, pitch, roll, differential, both bogies) are solved so that each
 * wheel centre sits one radius above the terrain directly below it: a point-contact model.
 * The ACE closed form on the flat-ground footprint seeds a Newton solve over the full linkage,
 * so the returned angles rebuild the returned wheel centres exactly.
 */
export function poseOnTerrain(
  heightAt: (x: number, y: number) => number,
  pose: PlanarPose,
  options: PoseOnTerrainOptions = {},
): RoverPose {
  const { geometry = DEFAULT_ROVER_GEOMETRY } = options
  const { x, y, headingRad } = pose
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(headingRad)) {
    throw new RoverError(
      'INVALID_POSE',
      `poseOnTerrain: pose is (${x}, ${y}, ${headingRad}); pass finite world metres and radians.`,
    )
  }
  const solver = new ContactSolver(heightAt, pose, geometry)
  const state = solver.solve(solver.initialState())
  return solver.toPose(state)
}

/** Unknowns: body z, pitch, roll, differential (left rocker), left bogie, right bogie. */
type State = Float64Array

interface Evaluation {
  wheels: Float64Array
  heights: Float64Array
  residuals: Float64Array
  worst: number
}

class ContactSolver {
  private readonly cos: number
  private readonly sin: number

  constructor(
    private readonly heightAt: (x: number, y: number) => number,
    private readonly pose: PlanarPose,
    private readonly g: ResolvedRoverGeometry,
  ) {
    this.cos = Math.cos(pose.headingRad)
    this.sin = Math.sin(pose.headingRad)
  }

  /**
   * Newton seed: ACE eqs. (2), (8)–(14) on the flat-ground footprint, with each link elevation
   * taken as atan of rise over footprint run instead of asin of rise over link length, so the
   * seed is exact on planes and defined on any slope.
   */
  initialState(): State {
    const { g } = this
    const r = g.wheelRadius
    const { links, rockerFlatRad: kd0, bogieFlatRad: kb0 } = g
    const phiF = kd0 - Math.atan2(g.bogiePivot.z - r, g.frontWheel.x - g.bogiePivot.x)
    const kd: number[] = []
    const kb: number[] = []
    const zd: number[] = []
    for (const side of [1, -1]) {
      const zf = this.groundAt(g.frontWheel.x, side * g.frontWheel.y) + r
      const zm = this.groundAt(g.middleWheel.x, side * g.middleWheel.y) + r
      const zr = this.groundAt(g.rearWheel.x, side * g.rearWheel.y) + r
      const kbSide = kb0 + Math.atan2(zr - zm, links.middleToRear)
      const zb = zm + links.bogieMiddle * Math.sin(kbSide)
      const xb = g.middleWheel.x - links.bogieMiddle * Math.cos(kbSide)
      const kdSide = phiF + Math.atan2(zb - zf, g.frontWheel.x - xb)
      kb.push(kbSide)
      kd.push(kdSide)
      zd.push(zf + links.rockerFront * Math.sin(kdSide))
    }
    const track = (g.frontWheel.y + g.middleWheel.y + g.rearWheel.y) / 3
    const state = new Float64Array(6)
    state[1] = (kd[0]! + kd[1]!) / 2 - kd0
    state[2] = Math.atan2(zd[0]! - zd[1]!, 2 * track)
    state[3] = (kd[1]! - kd[0]!) / 2
    state[4] = kd[0]! - kb[0]! - kd0 + kb0
    state[5] = kd[1]! - kb[1]! - kd0 + kb0
    const { residuals } = this.evaluate(state)
    let mean = 0
    for (const residual of residuals) mean += residual / 6
    state[0] = -mean
    return state
  }

  solve(start: State): State {
    let state = start
    let current = this.evaluate(state)
    for (let iteration = 0; current.worst > CONTACT_TOLERANCE_M; iteration++) {
      if (iteration === MAX_ITERATIONS) this.noContact(current)
      const step = solveLinear(
        this.jacobian(state, current),
        current.residuals.map((v) => -v),
      )
      if (!step) this.noContact(current)
      let scale = 1
      let accepted: { state: State; evaluation: Evaluation } | undefined
      for (let halving = 0; halving <= MAX_STEP_HALVINGS; halving++, scale /= 2) {
        const next = state.map((v, k) => v + scale * step[k]!)
        const evaluation = this.evaluate(next)
        if (evaluation.worst < current.worst) {
          accepted = { state: next, evaluation }
          break
        }
      }
      if (!accepted) this.noContact(current)
      state = accepted.state
      current = accepted.evaluation
    }
    this.checkLinkage(state, current)
    return state
  }

  toPose(state: State): RoverPose {
    const { g, pose } = this
    const { wheels, heights } = this.evaluate(state)
    const [z, pitch, roll, delta, betaLeft, betaRight] = Array.from(state)
    const m = rotation(pose.headingRad, pitch!, roll!)
    const wheelPoints: Point3[] = []
    const contacts: Point3[] = []
    for (let k = 0; k < 6; k++) {
      const wx = wheels[3 * k]!
      const wy = wheels[3 * k + 1]!
      wheelPoints.push({ x: wx, y: wy, z: wheels[3 * k + 2]! })
      contacts.push({ x: wx, y: wy, z: heights[k]! })
    }

    const nx = Math.ceil(g.bellyLength / BELLY_SAMPLE_M)
    const ny = Math.ceil(g.bellyWidth / BELLY_SAMPLE_M)
    let clearance = Infinity
    for (let i = 0; i <= nx; i++) {
      const bx = g.bellyOffsetX + g.bellyLength * (i / nx - 0.5)
      for (let j = 0; j <= ny; j++) {
        const by = g.bellyWidth * (j / ny - 0.5)
        const bz = g.bellyClearance
        const wx = pose.x + m[0] * bx + m[1] * by + m[2] * bz
        const wy = pose.y + m[3] * bx + m[4] * by + m[5] * bz
        const wz = z! + m[6] * bx + m[7] * by + m[8] * bz
        clearance = Math.min(clearance, wz - this.sample(wx, wy))
      }
    }

    return {
      position: { x: pose.x, y: pose.y, z: z! },
      headingRad: pose.headingRad,
      pitchRad: pitch!,
      rollRad: roll!,
      tiltRad: Math.acos(Math.min(1, Math.cos(pitch!) * Math.cos(roll!))),
      quaternion: quaternion(pose.headingRad, pitch!, roll!),
      wheels: wheelPoints,
      contacts,
      rocker: { left: delta!, right: -delta! },
      bogie: { left: betaLeft!, right: betaRight! },
      differentialRad: delta!,
      bellyClearanceM: clearance,
    }
  }

  /** Terrain height under a body-frame point of the flat-ground footprint. */
  private groundAt(bx: number, by: number): number {
    const { pose, cos, sin } = this
    return this.sample(pose.x + cos * bx - sin * by, pose.y + sin * bx + cos * by)
  }

  private sample(x: number, y: number): number {
    const h = this.heightAt(x, y)
    if (!Number.isFinite(h)) {
      throw new RoverError(
        'INVALID_POSE',
        `poseOnTerrain: heightAt(${x}, ${y}) is ${h} under the rover at (${this.pose.x}, ${this.pose.y}); place the rover where the height function is defined.`,
      )
    }
    return h
  }

  private evaluate(state: State): Evaluation {
    const wheels = this.worldLinkage(state)
    const heights = new Float64Array(6)
    const residuals = new Float64Array(6)
    let worst = 0
    for (let k = 0; k < 6; k++) {
      heights[k] = this.sample(wheels[3 * k]!, wheels[3 * k + 1]!)
      residuals[k] = wheels[3 * k + 2]! - this.g.wheelRadius - heights[k]!
      worst = Math.max(worst, Math.abs(residuals[k]!))
    }
    return { wheels, heights, residuals, worst }
  }

  /** ∂residual/∂state: linkage by central differences, terrain slope by forward differences. */
  private jacobian(state: State, current: Evaluation): Float64Array[] {
    const slopes = new Float64Array(12)
    for (let k = 0; k < 6; k++) {
      const wx = current.wheels[3 * k]!
      const wy = current.wheels[3 * k + 1]!
      const h = current.heights[k]!
      slopes[2 * k] = (this.sample(wx + GRADIENT_STEP_M, wy) - h) / GRADIENT_STEP_M
      slopes[2 * k + 1] = (this.sample(wx, wy + GRADIENT_STEP_M) - h) / GRADIENT_STEP_M
    }
    const rows = Array.from({ length: 6 }, () => new Float64Array(6))
    for (const row of rows) row[0] = 1
    for (let j = 1; j < 6; j++) {
      const plus = state.slice()
      const minus = state.slice()
      plus[j]! += ANGLE_STEP_RAD
      minus[j]! -= ANGLE_STEP_RAD
      const a = this.worldLinkage(plus)
      const b = this.worldLinkage(minus)
      for (let k = 0; k < 6; k++) {
        const dx = (a[3 * k]! - b[3 * k]!) / (2 * ANGLE_STEP_RAD)
        const dy = (a[3 * k + 1]! - b[3 * k + 1]!) / (2 * ANGLE_STEP_RAD)
        const dz = (a[3 * k + 2]! - b[3 * k + 2]!) / (2 * ANGLE_STEP_RAD)
        rows[k]![j] = dz - slopes[2 * k]! * dx - slopes[2 * k + 1]! * dy
      }
    }
    return rows
  }

  /** {@link bodyLinkage} points in world metres, 3 floats each (x, y, z). */
  private worldLinkage(state: State): Float64Array {
    const body = bodyLinkage(this.g, state[3]!, state[4]!, state[5]!)
    const m = rotation(this.pose.headingRad, state[1]!, state[2]!)
    const out = new Float64Array(24)
    for (let k = 0; k < 8; k++) {
      const bx = body[4 * k]!
      const by = body[4 * k + 1]!
      const bz = body[4 * k + 2]!
      out[3 * k] = this.pose.x + m[0] * bx + m[1] * by + m[2] * bz
      out[3 * k + 1] = this.pose.y + m[3] * bx + m[4] * by + m[5] * bz
      out[3 * k + 2] = state[0]! + m[6] * bx + m[7] * by + m[8] * bz
    }
    return out
  }

  /**
   * Refuses solutions outside the ACE triangle domain (|z_a − z_b| ≤ l_ab): each side's rear
   * wheel must stay behind its middle wheel and the bogie pivot behind the front wheel along
   * the heading, and the body must stay upright.
   */
  private checkLinkage(state: State, current: Evaluation): void {
    const { cos, sin } = this
    const along = (k: number): number =>
      current.wheels[3 * k]! * cos + current.wheels[3 * k + 1]! * sin
    for (const [side, label] of [
      [0, 'L'],
      [1, 'R'],
    ] as const) {
      if (along(2 + side) <= along(4 + side)) this.noContact(current, [`M${label}`, `R${label}`])
      if (along(side) <= along(6 + side)) this.noContact(current, [`F${label}`, `M${label}`])
    }
    if (!(Math.cos(state[1]!) > 0 && Math.cos(state[2]!) > 0)) this.noContact(current)
  }

  private noContact(current: Evaluation, pair?: [string, string]): never {
    const [a, b] = pair ?? worstPair(current)
    const { x, y, headingRad } = this.pose
    throw new RoverError(
      'NO_CONTACT',
      `poseOnTerrain: wheels ${a} and ${b} cannot both touch the ground at (${x}, ${y}, heading ${headingRad}); ` +
        'the terrain under them differs by more than the suspension spans. Plan the pose clear of this step or drop.',
    )
  }
}

/** The wheel with the largest residual, paired with the same-side wheel whose ground differs most from it. */
function worstPair(current: Evaluation): [string, string] {
  let worst = 0
  for (let k = 1; k < 6; k++) {
    if (Math.abs(current.residuals[k]!) > Math.abs(current.residuals[worst]!)) worst = k
  }
  let partner = worst
  let spread = -1
  for (let k = worst % 2; k < 6; k += 2) {
    const difference = Math.abs(current.heights[k]! - current.heights[worst]!)
    if (k !== worst && difference > spread) {
      spread = difference
      partner = k
    }
  }
  return [WHEEL_NAMES[worst]!, WHEEL_NAMES[partner]!]
}

/**
 * Body-frame linkage points, 4 floats each (x, y, z, unused): wheels FL, FR, ML, MR, RL, RR
 * at indices 0–5, then the bogie pivots L, R at 6–7. `delta` is the left rocker angle; the right
 * rocker turns by its opposite.
 */
export function bodyLinkage(
  g: ResolvedRoverGeometry,
  delta: number,
  betaLeft: number,
  betaRight: number,
): Float64Array {
  const out = new Float64Array(32)
  const r = g.wheelRadius
  const { rockerPivot: d, bogiePivot: b } = g
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1
    const rocker = sign * delta
    const bogie = side === 0 ? betaLeft : betaRight
    const cr = Math.cos(rocker)
    const sr = Math.sin(rocker)
    const cb = Math.cos(bogie)
    const sb = Math.sin(bogie)
    const onRocker = (index: number, px: number, pz: number, y: number): void => {
      const dx = px - d.x
      const dz = pz - d.z
      out[4 * index] = d.x + dx * cr - dz * sr
      out[4 * index + 1] = y
      out[4 * index + 2] = d.z + dx * sr + dz * cr
    }
    const onBogie = (index: number, px: number, y: number): void => {
      const dx = px - b.x
      const dz = r - b.z
      onRocker(index, b.x + dx * cb - dz * sb, b.z + dx * sb + dz * cb, y)
    }
    onRocker(side, g.frontWheel.x, r, sign * g.frontWheel.y)
    onBogie(2 + side, g.middleWheel.x, sign * g.middleWheel.y)
    onBogie(4 + side, g.rearWheel.x, sign * g.rearWheel.y)
    onRocker(6 + side, b.x, b.z, 0)
  }
  return out
}

/** Row-major `Rz(heading) · Ry(pitch) · Rx(roll)`. */
function rotation(
  heading: number,
  pitch: number,
  roll: number,
): [number, number, number, number, number, number, number, number, number] {
  const ch = Math.cos(heading)
  const sh = Math.sin(heading)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  return [
    ch * cp,
    ch * sp * sr - sh * cr,
    ch * sp * cr + sh * sr,
    sh * cp,
    sh * sp * sr + ch * cr,
    sh * sp * cr - ch * sr,
    -sp,
    cp * sr,
    cp * cr,
  ]
}

function quaternion(heading: number, pitch: number, roll: number): RoverPose['quaternion'] {
  const ch = Math.cos(heading / 2)
  const sh = Math.sin(heading / 2)
  const cp = Math.cos(pitch / 2)
  const sp = Math.sin(pitch / 2)
  const cr = Math.cos(roll / 2)
  const sr = Math.sin(roll / 2)
  return {
    x: sr * cp * ch - cr * sp * sh,
    y: cr * sp * ch + sr * cp * sh,
    z: cr * cp * sh - sr * sp * ch,
    w: cr * cp * ch + sr * sp * sh,
  }
}

/** Solves `a · x = b` by Gaussian elimination with partial pivoting; undefined when singular. */
function solveLinear(a: Float64Array[], b: Float64Array): Float64Array | undefined {
  const n = b.length
  const m = a.map((row) => row.slice())
  const v = b.slice()
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row
    }
    if (!(Math.abs(m[pivot]![col]!) > 1e-12)) return undefined
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    ;[v[col], v[pivot]] = [v[pivot]!, v[col]!]
    for (let row = col + 1; row < n; row++) {
      const factor = m[row]![col]! / m[col]![col]!
      for (let k = col; k < n; k++) m[row]![k]! -= factor * m[col]![k]!
      v[row]! -= factor * v[col]!
    }
  }
  const x = new Float64Array(n)
  for (let row = n - 1; row >= 0; row--) {
    let sum = v[row]!
    for (let k = row + 1; k < n; k++) sum -= m[row]![k]! * x[k]!
    x[row] = sum / m[row]![row]!
  }
  return x
}
