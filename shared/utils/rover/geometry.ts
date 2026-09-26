import { RoverError } from './errors'

/** A wheel centre in the body frame: `x` forward, `y` the lateral offset of the left wheel (the right one mirrors it). */
export interface WheelMount {
  x: number
  y: number
}

/** A suspension pivot in the body side plane: `x` forward, `z` up from the contact plane. */
export interface PivotMount {
  x: number
  z: number
}

/**
 * Rover body geometry in metres. Body frame: origin at the middle axle on the ground-contact
 * plane of flat ground, x forward, y left, z up. Omitted fields take the Perseverance-class
 * defaults of {@link DEFAULT_ROVER_GEOMETRY}.
 */
export interface RoverGeometry {
  wheelRadius?: number
  wheelWidth?: number
  frontWheel?: WheelMount
  middleWheel?: WheelMount
  rearWheel?: WheelMount
  /** Rocker (differential) pivot; the rocker carries the front wheel and the bogie pivot. */
  rockerPivot?: PivotMount
  /** Bogie pivot on flat ground; the bogie carries the middle and rear wheels. */
  bogiePivot?: PivotMount
  /** Height of the rigid belly-pan plane above the contact plane on flat ground. */
  bellyClearance?: number
  /** Belly-pan footprint along x. */
  bellyLength?: number
  /** Belly-pan footprint along y, centred on the body. */
  bellyWidth?: number
  /** x of the belly-pan footprint centre. */
  bellyOffsetX?: number
}

/**
 * Link lengths in the side plane (x, z) on flat ground. Symbols in parentheses are those of the
 * ACE rocker-bogie equations.
 */
export interface RoverLinks {
  /** Rocker pivot → front wheel centre (l_df). */
  rockerFront: number
  /** Rocker pivot → bogie pivot (l_db). */
  rockerBogie: number
  /** Bogie pivot → middle wheel centre (l_bm). */
  bogieMiddle: number
  /** Bogie pivot → rear wheel centre (l_br). */
  bogieRear: number
  /** Front wheel centre → bogie pivot: the rocker triangle's base (l_ab of the rocker). */
  frontToBogie: number
  /** Middle → rear wheel centre: the bogie triangle's base (l_ab of the bogie). */
  middleToRear: number
}

export interface ResolvedRoverGeometry {
  readonly wheelRadius: number
  readonly wheelWidth: number
  readonly frontWheel: Readonly<WheelMount>
  readonly middleWheel: Readonly<WheelMount>
  readonly rearWheel: Readonly<WheelMount>
  readonly rockerPivot: Readonly<PivotMount>
  readonly bogiePivot: Readonly<PivotMount>
  readonly bellyClearance: number
  readonly bellyLength: number
  readonly bellyWidth: number
  readonly bellyOffsetX: number
  readonly links: Readonly<RoverLinks>
  /** Flat-ground elevation of front wheel → rocker pivot above the aft horizontal (κ_d0). */
  readonly rockerFlatRad: number
  /** Flat-ground elevation of middle wheel → bogie pivot above the aft horizontal (κ_b0). */
  readonly bogieFlatRad: number
}

/**
 * Suspension pivots from NASA/JPL's Mars 2020 URDF
 * (github.com/nasa-jpl/m2020-urdf-models@c422fc6d96f2684521fb64049448d611e670f140, the source of
 * `public/models/rover/`) with every joint at zero, to the millimetre. Wheel centres are from
 * NASA's Perseverance model and agree with the URDF's within 2.5 mm. The belly footprint is the
 * model's body extent at the 0.60 m clearance the landing-site rock criterion implies.
 */
const DEFAULTS = {
  wheelRadius: 0.263,
  wheelWidth: 0.335,
  frontWheel: { x: 1.185, y: 1.065 },
  middleWheel: { x: 0, y: 1.185 },
  rearWheel: { x: -1.075, y: 1.065 },
  rockerPivot: { x: 0.304, z: 0.893 },
  bogiePivot: { x: -0.45, z: 0.663 },
  bellyClearance: 0.6,
  bellyLength: 2.08,
  bellyWidth: 1.55,
  bellyOffsetX: -0.05,
} satisfies Required<RoverGeometry>

export function defineRoverGeometry(geometry: RoverGeometry = {}): ResolvedRoverGeometry {
  const g = { ...DEFAULTS, ...geometry }
  const scalars = [
    'wheelRadius',
    'wheelWidth',
    'bellyClearance',
    'bellyLength',
    'bellyWidth',
  ] as const
  for (const name of scalars) requirePositive(g[name], name)
  requireFinite(g.bellyOffsetX, 'bellyOffsetX')
  for (const name of ['frontWheel', 'middleWheel', 'rearWheel'] as const) {
    requireFinite(g[name].x, `${name}.x`)
    requirePositive(g[name].y, `${name}.y`)
  }
  for (const name of ['rockerPivot', 'bogiePivot'] as const) {
    requireFinite(g[name].x, `${name}.x`)
    if (!(g[name].z > g.wheelRadius) || !Number.isFinite(g[name].z)) {
      throw new RoverError(
        'INVALID_GEOMETRY',
        `defineRoverGeometry: ${name}.z is ${g[name].z}; pass a finite height above the wheel radius (${g.wheelRadius}).`,
      )
    }
  }
  const { frontWheel: f, middleWheel: m, rearWheel: r, rockerPivot: d, bogiePivot: b } = g
  if (!(f.x > d.x && d.x > b.x && m.x > b.x && b.x > r.x && f.x > m.x)) {
    throw new RoverError(
      'INVALID_GEOMETRY',
      `defineRoverGeometry: x positions front ${f.x}, rocker pivot ${d.x}, middle ${m.x}, bogie pivot ${b.x}, rear ${r.x} are out of layout order; ` +
        'pass front > middle, the bogie pivot between middle and rear, and the rocker pivot between the front wheel and the bogie pivot.',
    )
  }

  const z = g.wheelRadius
  const links: RoverLinks = Object.freeze({
    rockerFront: Math.hypot(f.x - d.x, z - d.z),
    rockerBogie: Math.hypot(d.x - b.x, d.z - b.z),
    bogieMiddle: Math.hypot(m.x - b.x, z - b.z),
    bogieRear: Math.hypot(b.x - r.x, b.z - z),
    frontToBogie: Math.hypot(f.x - b.x, z - b.z),
    middleToRear: m.x - r.x,
  })
  return Object.freeze({
    wheelRadius: g.wheelRadius,
    wheelWidth: g.wheelWidth,
    frontWheel: Object.freeze({ x: f.x, y: f.y }),
    middleWheel: Object.freeze({ x: m.x, y: m.y }),
    rearWheel: Object.freeze({ x: r.x, y: r.y }),
    rockerPivot: Object.freeze({ x: d.x, z: d.z }),
    bogiePivot: Object.freeze({ x: b.x, z: b.z }),
    bellyClearance: g.bellyClearance,
    bellyLength: g.bellyLength,
    bellyWidth: g.bellyWidth,
    bellyOffsetX: g.bellyOffsetX,
    links,
    rockerFlatRad: Math.atan2(d.z - z, f.x - d.x),
    bogieFlatRad: Math.atan2(b.z - z, m.x - b.x),
  })
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RoverError(
      'INVALID_GEOMETRY',
      `defineRoverGeometry: ${name} is ${value}; pass a finite number of metres.`,
    )
  }
}

function requirePositive(value: number, name: string): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RoverError(
      'INVALID_GEOMETRY',
      `defineRoverGeometry: ${name} is ${value}; pass a finite number of metres greater than 0.`,
    )
  }
}

export const DEFAULT_ROVER_GEOMETRY: ResolvedRoverGeometry = defineRoverGeometry()
