import type { SegmentRecord } from '#shared/utils/drive'
import { driveSegment } from '#shared/utils/drive'
import { computeStopDisk, createRevealedMask, defineWorld, revealDisk } from '#shared/utils/terrain'

/** World seeds the playground drives; each fixture is named after its seed. */
export const FIXTURE_NAMES = ['mars', 'jezero', 'gale'] as const

const START = { x: 0, y: 0, headingRad: 0 }
/** 150 m from the start: about 1 h 30 min of driving, inside the 15 min to 2 h time band. */
const GOAL = { x: 120, y: 90 }

const records = new Map<string, SegmentRecord>()

/**
 * The drive from stop 0 at the origin toward {@link GOAL} on world `name`, generated on first
 * request and kept for the life of the process; undefined for a name not in
 * {@link FIXTURE_NAMES}.
 */
export function fixtureRecord(name: string): SegmentRecord | undefined {
  if (!(FIXTURE_NAMES as readonly string[]).includes(name)) return undefined
  let record = records.get(name)
  if (!record) {
    const world = defineWorld({ seed: name })
    const disk = computeStopDisk(world, { center: START })
    const revealed = revealDisk(createRevealedMask(world), disk)
    record = driveSegment(world, { disk, revealed, start: START, goal: GOAL }).record
    records.set(name, record)
  }
  return record
}
