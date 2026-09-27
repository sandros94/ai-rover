import type { StopDisk } from '#shared/utils/terrain'
import { surveyMask } from '#shared/utils/terrain'
import { NavError } from '#shared/utils/nav'

/** The NavError thrown by `fn`, or undefined when it throws nothing or something else. */
export function navErrorOf(fn: () => unknown): NavError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof NavError) return error
  }
  return undefined
}

/**
 * A square synthetic disk centred on world (0, 0) at 1 m cells: `size` vertices a side (odd),
 * heights from `heightAt(x, y)` in world metres, everything traversable unless `blocked` says so.
 */
export function syntheticDisk(options: {
  size: number
  radius: number
  heightAt?: (x: number, y: number) => number
  blocked?: (x: number, y: number) => boolean
}): StopDisk {
  const { size, radius, heightAt = () => 0, blocked = () => false } = options
  const half = (size - 1) / 2
  const heights = new Float32Array(size * size)
  const traversable = new Uint8Array(size * size)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      heights[j * size + i] = heightAt(i - half, j - half)
      traversable[j * size + i] = blocked(i - half, j - half) ? 0 : 1
    }
  }
  const grid = { heights, width: size, height: size, cellSize: 1 }
  const origin = { i: -half, j: -half }
  return {
    center: { x: 0, y: 0 },
    radius,
    chunks: [],
    grid,
    origin,
    traversable,
    inside: surveyMask({ grid, origin }, { center: { x: 0, y: 0 }, radius }),
    visible: new Uint8Array(size * size).fill(1),
  }
}
