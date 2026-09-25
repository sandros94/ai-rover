import { NavError } from './errors'

/**
 * One execution step. Angles and curvature are counter-clockwise positive (x east, y north);
 * `curvature` is 1 / radius in m⁻¹, 0 for a straight drive. Closed union: callers may match on
 * `type` exhaustively, so adding a variant is a breaking change.
 */
export type Motion =
  | { type: 'turn'; angleRad: number }
  | { type: 'arc'; lengthM: number; curvature: number }

export interface MotionOptions {
  /** Heading changes larger than this turn in place; smaller ones are blended. Default 30°. */
  turnInPlaceAboveRad?: number
  /** Radius of blend arcs; a vertex whose shorter adjacent segment is under twice this turns in place. Default 2 m. */
  blendRadiusM?: number
  /** Heading the rover starts with; when given, a turn in place onto the first segment leads. */
  initialHeadingRad?: number
}

/**
 * Converts a polyline in world metres into turns in place and constant-curvature arcs. A blended
 * vertex is replaced by a tangent arc, so the motions cut its corner: they are shorter than the
 * polyline by `2R·(tan(Δ/2) − Δ/2)` per blend and pass within `R·(sec(Δ/2) − 1)` of the vertex.
 * Repeated points are dropped; a single point yields no motion.
 */
export function motionsFromPolyline(
  points: { x: number; y: number }[],
  options: MotionOptions = {},
): Motion[] {
  const { turnInPlaceAboveRad = Math.PI / 6, blendRadiusM = 2, initialHeadingRad } = options
  if (points.length === 0) {
    throw new NavError(
      'INVALID_INPUT',
      'motionsFromPolyline: points is empty; pass at least one point.',
    )
  }
  for (const [k, { x, y }] of points.entries()) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new NavError(
        'INVALID_INPUT',
        `motionsFromPolyline: point ${k} is (${x}, ${y}); pass finite world coordinates in metres.`,
      )
    }
  }
  if (!(turnInPlaceAboveRad >= 0 && turnInPlaceAboveRad <= Math.PI)) {
    throw new NavError(
      'INVALID_INPUT',
      `motionsFromPolyline: turnInPlaceAboveRad is ${turnInPlaceAboveRad}; pass radians from 0 to π.`,
    )
  }
  if (!(Number.isFinite(blendRadiusM) && blendRadiusM > 0)) {
    throw new NavError(
      'INVALID_INPUT',
      `motionsFromPolyline: blendRadiusM is ${blendRadiusM}; pass a finite number of metres greater than 0.`,
    )
  }
  if (initialHeadingRad !== undefined && !Number.isFinite(initialHeadingRad)) {
    throw new NavError(
      'INVALID_INPUT',
      `motionsFromPolyline: initialHeadingRad is ${initialHeadingRad}; pass finite radians or omit it.`,
    )
  }

  const headings: number[] = []
  const lengths: number[] = []
  let last = points[0]!
  for (const point of points) {
    const dx = point.x - last.x
    const dy = point.y - last.y
    if (dx === 0 && dy === 0) continue
    headings.push(Math.atan2(dy, dx))
    lengths.push(Math.hypot(dx, dy))
    last = point
  }
  const motions: Motion[] = []
  if (headings.length === 0) return motions
  if (initialHeadingRad !== undefined) {
    const angleRad = wrapAngle(headings[0]! - initialHeadingRad)
    if (angleRad !== 0) motions.push({ type: 'turn', angleRad })
  }

  /** Change at the vertex ending segment s, and how far its blend arc eats into each side. */
  const turns = headings.map((heading, s) =>
    s + 1 < headings.length ? wrapAngle(headings[s + 1]! - heading) : 0,
  )
  const blends = turns.map((turn, s) => {
    if (turn === 0 || Math.abs(turn) > turnInPlaceAboveRad) return false
    return blendRadiusM <= Math.min(lengths[s]!, lengths[s + 1]!) / 2
  })
  for (let s = 0; s < headings.length; s++) {
    const cutIn = s > 0 && blends[s - 1] ? blendRadiusM * Math.tan(Math.abs(turns[s - 1]!) / 2) : 0
    const cutOut = blends[s] ? blendRadiusM * Math.tan(Math.abs(turns[s]!) / 2) : 0
    const straight = lengths[s]! - cutIn - cutOut
    const previous = motions.at(-1)
    if (previous?.type === 'arc' && previous.curvature === 0) previous.lengthM += straight
    else if (straight > 0) motions.push({ type: 'arc', lengthM: straight, curvature: 0 })
    const turn = turns[s]!
    if (turn === 0) continue
    if (blends[s]) {
      motions.push({
        type: 'arc',
        lengthM: blendRadiusM * Math.abs(turn),
        curvature: Math.sign(turn) / blendRadiusM,
      })
    } else {
      motions.push({ type: 'turn', angleRad: turn })
    }
  }
  return motions
}

/** `angle` folded into (−π, π]. */
function wrapAngle(angle: number): number {
  let out = angle % (2 * Math.PI)
  if (out > Math.PI) out -= 2 * Math.PI
  else if (out <= -Math.PI) out += 2 * Math.PI
  return out
}
