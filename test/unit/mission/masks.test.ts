import { describe, expect, it } from 'vitest'
import type { ChainSegment, ChainStop } from '#shared/utils/mission'
import { MissionError, placeReveals, rebuildStopMasks } from '#shared/utils/mission'
import type { RevealedMask, StopDisk } from '#shared/utils/terrain'
import {
  chunksCoveringDisk,
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  encodeRevealedMask,
  revealDisk,
  revealVertices,
} from '#shared/utils/terrain'

const world = defineWorld({ seed: 'mars' })
const RADIUS = 60

/** Landing at the origin, then two drives: 0 → 1 → 2, and a retry from 0 that reached 3. */
const STOPS: ChainStop[] = [
  { id: 's0', index: 0, x: 0, y: 0, fromSegmentId: null },
  { id: 's1', index: 1, x: 30, y: 0, fromSegmentId: 'd1' },
  { id: 's2', index: 2, x: 55, y: 20, fromSegmentId: 'd2' },
  { id: 's3', index: 3, x: -25, y: -20, fromSegmentId: 'd3' },
]
const SEGMENTS: ChainSegment[] = [
  { id: 'd1', fromStopId: 's0' },
  { id: 'd2', fromStopId: 's1' },
  { id: 'd3', fromStopId: 's0' },
]

const disks = new Map(
  STOPS.map((stop) => [stop.id, computeStopDisk(world, { center: stop, radius: RADIUS })]),
)
const diskOf = (stop: ChainStop): StopDisk => disks.get(stop.id)!

/** A row of vertices near the left stop per drive, over its disk's grid, as a record lists them. */
function revealsOf(segment: ChainSegment): Promise<number[]> {
  const { grid, origin, center } = disks.get(segment.fromStopId)!
  const row = Math.round(center.y) - origin.j + 5 + SEGMENTS.indexOf(segment) * 3
  const column = Math.round(center.x) - origin.i - 20
  return Promise.resolve(Array.from({ length: 40 }, (_, k) => row * grid.width + column + k))
}

/** The masks as settlement builds them, stop by stop. */
async function expected(): Promise<Map<string, RevealedMask>> {
  const masks = new Map<string, RevealedMask>()
  masks.set('s0', revealDisk(createRevealedMask(world), disks.get('s0')!))
  for (const stop of STOPS.slice(1)) {
    const segment = SEGMENTS.find((s) => s.id === stop.fromSegmentId)!
    const seen = revealVertices(
      masks.get(segment.fromStopId)!,
      disks.get(segment.fromStopId)!,
      await revealsOf(segment),
    )
    masks.set(stop.id, revealDisk(seen, disks.get(stop.id)!))
  }
  return masks
}

async function rebuilt(options: Partial<Parameters<typeof rebuildStopMasks>[0]> = {}) {
  const out = new Map<string, RevealedMask>()
  for await (const { stop, mask } of rebuildStopMasks({
    stops: STOPS,
    segments: SEGMENTS,
    empty: createRevealedMask(world),
    diskOf,
    revealsOf,
    chunkSize: 64,
    ...options,
  })) {
    out.set(stop.id, mask)
  }
  return out
}

const bytes = (masks: Map<string, RevealedMask>) =>
  Object.fromEntries([...masks].map(([id, mask]) => [id, encodeRevealedMask(mask)]))

describe('rebuildStopMasks', () => {
  it('computes every mask from the landing as settlement does, a retry from the stop it left', async () => {
    const want = await expected()
    expect(bytes(await rebuilt())).toEqual(bytes(want))
    // The retry from the landing holds nothing the first drive's stops revealed.
    expect(encodeRevealedMask(want.get('s3')!)).not.toEqual(encodeRevealedMask(want.get('s2')!))
  })

  it('restores the masks after a stale one, which a stored chain would carry on', async () => {
    const want = await expected()
    // Stop 1 stored with the landing's mask, as a racing tick could leave it.
    const stale = new Map(want)
    stale.set('s1', want.get('s0')!)
    const read: string[] = []
    const resumed = await rebuilt({
      from: 2,
      maskOf: async (stop) => (read.push(stop.id), stale.get(stop.id)!),
    })
    expect(read).toEqual(['s1', 's0'])
    // Resumed from the stored masks, stop 2 is built on the stale one…
    expect(encodeRevealedMask(resumed.get('s2')!)).not.toEqual(encodeRevealedMask(want.get('s2')!))
    // …and from the landing, it is exactly what settlement would have stored.
    expect(bytes(await rebuilt())).toEqual(bytes(want))
  })

  it('refuses a stop reached by a drive it is not given', async () => {
    const error = await rebuilt({ segments: SEGMENTS.slice(1) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissionError)
    expect((error as MissionError).message).toContain('d1')
  })

  it('refuses a stop left before its own mask was rebuilt', async () => {
    const error = await rebuilt({ stops: [STOPS[0]!, STOPS[2]!, STOPS[1]!] }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MissionError)
  })
})

describe('placeReveals', () => {
  const disk = disks.get('s1')!
  const { grid, origin, center } = disk
  /** World vertices within the survey, a few metres around the stop. */
  const near = Array.from({ length: 30 }, (_, k) => ({
    i: Math.round(center.x) - 15 + k,
    j: Math.round(center.y) + (k % 7) - 3,
  }))
  const over = (layout: { origin: { i: number; j: number }; width: number }) =>
    near.map(({ i, j }) => (j - layout.origin.j) * layout.width + (i - layout.origin.i))

  it("keeps reveals recorded over the disk's own grid", () => {
    expect(
      Array.from(placeReveals(disk, over({ origin, width: grid.width }), { chunkSize: 64 })),
    ).toEqual(over({ origin, width: grid.width }))
  })

  it('moves reveals recorded over the chunks within the survey alone onto the disk', () => {
    const bare = chunksCoveringDisk(world, { center, radius: RADIUS })
    const cx = bare.map((c) => c.cx)
    const cy = bare.map((c) => c.cy)
    const layout = {
      origin: { i: Math.min(...cx) * 64, j: Math.min(...cy) * 64 },
      width: (Math.max(...cx) - Math.min(...cx) + 1) * 64 + 1,
    }
    expect(layout.width).not.toBe(grid.width)
    expect(Array.from(placeReveals(disk, over(layout), { chunkSize: 64 }))).toEqual(
      over({ origin, width: grid.width }),
    )
  })

  it('refuses reveals that lie outside the survey in every grid', () => {
    const far = [grid.width * grid.height - 1, 0]
    expect(() => placeReveals(disk, far, { chunkSize: 64 })).toThrow(MissionError)
  })
})
