import type { StopDisk } from '../terrain/disk'
import { SURVEY_MARGIN_M } from '../terrain/disk'
import type { RevealedMask } from '../terrain/revealed'
import { revealDisk, revealVertices } from '../terrain/revealed'
import { MissionError } from './errors'

/** The revealed mask as of the landing stop: the viewshed from it over `empty`. */
export function landingMask(empty: RevealedMask, disk: StopDisk): RevealedMask {
  return revealDisk(empty, disk)
}

/**
 * The revealed mask as of a stop a drive reached: the mask of the stop it left, what it revealed
 * on the way (`reveals`, vertices of the left stop's disk grid, as its record lists them) and the
 * viewshed from the stop reached (`disk`).
 */
export function reachedMask(
  left: { mask: RevealedMask; disk: StopDisk },
  options: { reveals: ArrayLike<number>; disk: StopDisk },
): RevealedMask {
  return revealDisk(revealVertices(left.mask, left.disk, options.reveals), options.disk)
}

/**
 * A drive's recorded reveals as vertices of `disk`'s grid, `disk` being the stop the drive left.
 * A record lists them over the grid of the disk its drive was planned on: the chunks within the
 * survey and its margin (`SURVEY_MARGIN_M`), or, for drives planned before stop disks carried
 * that margin, the chunks within the survey alone. Nothing records which, but every reveal lies
 * within the survey, so the layout is the first of `disk`'s own, the margined one and the bare
 * one in which all of them do; with none, the record belongs to another stop and is refused.
 */
export function placeReveals(
  disk: Pick<StopDisk, 'center' | 'radius' | 'grid' | 'origin'>,
  vertices: ArrayLike<number>,
  options: { chunkSize: number },
): ArrayLike<number> {
  const { center, radius, grid, origin } = disk
  const { cellSize } = grid
  const cells = options.chunkSize / cellSize
  /** The grid of the chunks within `reach` metres of the centre: their bounding box. */
  const covering = (reach: number) => {
    const low = (c: number) => Math.floor((c - reach) / options.chunkSize) * cells
    const size = (c: number) =>
      (Math.floor((c + reach) / options.chunkSize) -
        Math.floor((c - reach) / options.chunkSize) +
        1) *
        cells +
      1
    return {
      origin: { i: low(center.x), j: low(center.y) },
      width: size(center.x),
      height: size(center.y),
    }
  }
  const layouts = [
    { origin, width: grid.width, height: grid.height },
    covering(radius + SURVEY_MARGIN_M),
    covering(radius),
  ]
  const radius2 = radius * radius
  for (const layout of layouts) {
    const placed = new Uint32Array(vertices.length)
    let fits = true
    for (let n = 0; n < vertices.length && fits; n++) {
      const k = vertices[n]!
      const i = layout.origin.i + (k % layout.width)
      const j = layout.origin.j + Math.floor(k / layout.width)
      const dx = i * cellSize - center.x
      const dy = j * cellSize - center.y
      const gi = i - origin.i
      const gj = j - origin.j
      fits =
        k < layout.width * layout.height &&
        dx * dx + dy * dy <= radius2 &&
        gi >= 0 &&
        gj >= 0 &&
        gi < grid.width &&
        gj < grid.height
      placed[n] = gj * grid.width + gi
    }
    if (fits) return placed
  }
  throw new MissionError(
    'INVALID_INPUT',
    `The ${vertices.length} reveals lie outside the survey of the stop at (${center.x}, ${center.y}) in every grid a drive from it was recorded over; pass the record of a drive that left this stop.`,
  )
}

/** A stop as {@link rebuildStopMasks} reads it. */
export interface ChainStop {
  id: string
  index: number
  x: number
  y: number
  /** The drive that reached it; null for the landing stop. */
  fromSegmentId: string | null
}

/** A drive as {@link rebuildStopMasks} reads it. */
export interface ChainSegment {
  id: string
  fromStopId: string
}

/**
 * Every stop's revealed mask computed again from the landing, in index order, with the functions
 * settlement uses: the landing's viewshed, then for each stop reached the mask of the stop its
 * drive left ∪ the drive's reveals (placed on the left stop's disk, see {@link placeReveals}) ∪
 * the viewshed where it ended. `from` starts at a later stop:
 * the masks of stops before it are then read with `maskOf`, so they must already be right. Only
 * the loaders do I/O; disks are asked for as needed, the one left and the one reached per stop.
 */
export async function* rebuildStopMasks(chain: {
  /** Every stop of the mission, by index. */
  stops: readonly ChainStop[]
  /** Every drive that reached one of them. */
  segments: readonly ChainSegment[]
  /** A mask with nothing seen, of the mission's world. */
  empty: RevealedMask
  diskOf: (stop: ChainStop) => StopDisk | Promise<StopDisk>
  /** The drive's reveals as its record lists them. */
  revealsOf: (segment: ChainSegment) => Promise<ArrayLike<number>>
  /** The world's chunk size, metres. */
  chunkSize: number
  /** Position in `stops` to start at; default 0, the landing. */
  from?: number
  /** The mask of a stop before `from`. */
  maskOf?: (stop: ChainStop) => Promise<RevealedMask>
}): AsyncGenerator<{ stop: ChainStop; mask: RevealedMask; disk: StopDisk }> {
  const { stops, empty, diskOf, revealsOf, chunkSize, from = 0, maskOf } = chain
  const byId = new Map(stops.map((stop) => [stop.id, stop]))
  const segments = new Map(chain.segments.map((segment) => [segment.id, segment]))
  const masks = new Map<string, RevealedMask>()
  async function maskBefore(stop: ChainStop): Promise<RevealedMask> {
    const rebuilt = masks.get(stop.id)
    if (rebuilt) return rebuilt
    if (!maskOf || stops.indexOf(stop) >= from) {
      throw new MissionError(
        'INVALID_INPUT',
        `Stop ${stop.index} is left by a later drive before its own mask was rebuilt; pass the stops in index order.`,
      )
    }
    const read = await maskOf(stop)
    masks.set(stop.id, read)
    return read
  }

  for (const stop of stops.slice(from)) {
    const disk = await diskOf(stop)
    let mask: RevealedMask
    if (stop.fromSegmentId === null) mask = landingMask(empty, disk)
    else {
      const segment = segments.get(stop.fromSegmentId)
      const left = segment && byId.get(segment.fromStopId)
      if (!segment || !left) {
        throw new MissionError(
          'INVALID_INPUT',
          `Stop ${stop.index} was reached by segment ${stop.fromSegmentId}, which is not among the drives or leaves no listed stop; pass every drive that reached a stop.`,
        )
      }
      const leftDisk = await diskOf(left)
      mask = reachedMask(
        { mask: await maskBefore(left), disk: leftDisk },
        { reveals: placeReveals(leftDisk, await revealsOf(segment), { chunkSize }), disk },
      )
    }
    masks.set(stop.id, mask)
    yield { stop, mask, disk }
  }
}
