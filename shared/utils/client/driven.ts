import type { KeyframeBlock } from '../drive/keyframes'
import { KEYFRAME_FIELDS } from '../drive/keyframes'

/** A point of the path driven: world metres and the sim time the rover passed it. */
export interface DrivenPoint {
  x: number
  y: number
  z: number
  t: number
}

/** Most points of a driven path; longer drives are thinned evenly. */
export const DRIVEN_POINTS = 400

const T = KEYFRAME_FIELDS.indexOf('t')
const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const Z = KEYFRAME_FIELDS.indexOf('z')

/**
 * The path driven through `keyframes`, after `before` (`t, x, y, z` per point: the traces'
 * path up to the block, see `SegmentStream.pathBefore`), at most `maxPoints` points taken evenly
 * and the last always kept.
 */
export function drivenPath(
  keyframes: KeyframeBlock | undefined,
  before: Float32Array = new Float32Array(0),
  maxPoints = DRIVEN_POINTS,
): DrivenPoint[] {
  const head = before.length / 4
  const frames = keyframes?.count ?? 0
  const total = head + frames
  if (total === 0) return []
  const point = (k: number): DrivenPoint => {
    if (k < head) {
      const o = k * 4
      return { t: before[o]!, x: before[o + 1]!, y: before[o + 2]!, z: before[o + 3]! }
    }
    const { data, stride } = keyframes!
    const o = (k - head) * stride
    return { t: data[o + T]!, x: data[o + X]!, y: data[o + Y]!, z: data[o + Z]! }
  }
  const step = Math.max(1, Math.ceil(total / Math.max(1, maxPoints - 1)))
  const points: DrivenPoint[] = []
  for (let k = 0; k < total - 1; k += step) points.push(point(k))
  points.push(point(total - 1))
  return points
}
