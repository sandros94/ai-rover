import { describe, expect, it } from 'vitest'
import { computeStopDisk, defineWorld } from '#shared/utils/terrain'
import { decodeDiskWire, encodeDiskWire } from '~~/modules/dev/runtime/shared/disk-wire'

describe('disk wire format', () => {
  const disk = computeStopDisk(defineWorld({ seed: 'gale' }), {
    center: { x: 30, y: -20 },
    radius: 90,
  })
  const wire = decodeDiskWire(encodeDiskWire(disk))

  it('round-trips the grid, placement and reachability seed', () => {
    expect(wire.grid).toEqual(disk.grid)
    expect(wire.origin).toEqual(disk.origin)
    expect(wire.center).toEqual(disk.center)
    expect(wire.reachableFrom).toEqual(disk.reachableFrom)
  })

  it('packs the three masks into one flag byte per vertex', () => {
    for (let k = 0; k < disk.traversable.length; k++) {
      expect(wire.traversable[k]).toBe(disk.traversable[k] ? 1 : 0)
      expect(wire.reachable[k]).toBe(disk.reachable[k] ? 1 : 0)
      expect(wire.visible[k]).toBe(disk.visible[k] ? 1 : 0)
    }
  })
})
