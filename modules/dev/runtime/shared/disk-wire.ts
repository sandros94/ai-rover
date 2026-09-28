import type { GridCell, HeightGrid, StopDisk } from '#shared/utils/terrain'
import { believedReachable } from '#shared/utils/terrain'

/**
 * Header before the arrays, little-endian: u32 width, u32 height, f32 cellSize, i32 originI,
 * i32 originJ, f32 centerX, f32 centerY, i32 reachableFromI, i32 reachableFromJ. Then f32 heights
 * and one flag byte per vertex.
 */
const HEADER_BYTES = 36

const FLAG_TRAVERSABLE = 1
const FLAG_REACHABLE = 2
const FLAG_VISIBLE = 4

/**
 * A stop disk as the viewer receives it: grid, placement and masks, one byte per vertex each.
 * Reachability is the rover's belief with only the stop's own view seen (see `believedReachable`).
 */
export interface DiskWire {
  grid: HeightGrid
  origin: GridCell
  center: { x: number; y: number }
  reachableFrom: GridCell
  traversable: Uint8Array
  reachable: Uint8Array
  visible: Uint8Array
}

export function encodeDiskWire(disk: StopDisk): ArrayBuffer {
  const { width, height, cellSize, heights } = disk.grid
  const count = width * height
  const belief = believedReachable(disk, disk.visible)
  const body = new ArrayBuffer(HEADER_BYTES + count * 5)
  const view = new DataView(body)
  view.setUint32(0, width, true)
  view.setUint32(4, height, true)
  view.setFloat32(8, cellSize, true)
  view.setInt32(12, disk.origin.i, true)
  view.setInt32(16, disk.origin.j, true)
  view.setFloat32(20, disk.center.x, true)
  view.setFloat32(24, disk.center.y, true)
  view.setInt32(28, belief.from.i, true)
  view.setInt32(32, belief.from.j, true)
  for (let k = 0; k < count; k++) view.setFloat32(HEADER_BYTES + k * 4, heights[k]!, true)
  const flags = new Uint8Array(body, HEADER_BYTES + count * 4, count)
  for (let k = 0; k < count; k++) {
    flags[k] =
      (disk.traversable[k] ? FLAG_TRAVERSABLE : 0) |
      (belief.reachable[k] ? FLAG_REACHABLE : 0) |
      (disk.visible[k] ? FLAG_VISIBLE : 0)
  }
  return body
}

export function decodeDiskWire(buffer: ArrayBuffer): DiskWire {
  const view = new DataView(buffer)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const cellSize = view.getFloat32(8, true)
  const count = width * height
  const heights = new Float32Array(count)
  for (let k = 0; k < count; k++) heights[k] = view.getFloat32(HEADER_BYTES + k * 4, true)
  const flags = new Uint8Array(buffer, HEADER_BYTES + count * 4, count)
  const traversable = new Uint8Array(count)
  const reachable = new Uint8Array(count)
  const visible = new Uint8Array(count)
  for (let k = 0; k < count; k++) {
    traversable[k] = flags[k]! & FLAG_TRAVERSABLE ? 1 : 0
    reachable[k] = flags[k]! & FLAG_REACHABLE ? 1 : 0
    visible[k] = flags[k]! & FLAG_VISIBLE ? 1 : 0
  }
  return {
    grid: { heights, width, height, cellSize },
    origin: { i: view.getInt32(12, true), j: view.getInt32(16, true) },
    center: { x: view.getFloat32(20, true), y: view.getFloat32(24, true) },
    reachableFrom: { i: view.getInt32(28, true), j: view.getInt32(32, true) },
    traversable,
    reachable,
    visible,
  }
}
