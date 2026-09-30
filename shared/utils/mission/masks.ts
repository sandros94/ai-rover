import type { StopDisk } from '../terrain/disk'
import type { RevealedMask } from '../terrain/revealed'
import { revealDisk, revealVertices } from '../terrain/revealed'

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
