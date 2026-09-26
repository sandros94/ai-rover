import type { DriveOutcome, SegmentRecord } from '#shared/utils/drive'

/**
 * Outcomes forced onto the next drives, in order: the rover still drives the real terrain, but
 * the record ends as given; or errors the next drives throw instead. Hidden hazards severe enough to fail or stop a drive are rare on the
 * default terrain, so tests inject them. A test file opts in with
 * `vi.mock('#shared/utils/drive/segment', async (original) => (await import('./forced')).forcedDriveSegment(original))`,
 * importing the module inside the factory since `vi.mock` is hoisted above the imports.
 */
export const forced = {
  outcomes: [] as ((real: DriveOutcome) => DriveOutcome)[],
  /** Thrown by the next drives instead of driving, in order, before `outcomes` apply. */
  errors: [] as Error[],
  /** Records replacing the next drives' whole records, in order, after `outcomes` apply. */
  records: [] as ((real: SegmentRecord) => SegmentRecord)[],
}

export async function forcedDriveSegment(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof import('#shared/utils/drive/segment')> {
  const actual = await importOriginal<typeof import('#shared/utils/drive/segment')>()
  return {
    ...actual,
    driveSegment: (...args: Parameters<typeof actual.driveSegment>) => {
      const error = forced.errors.shift()
      if (error) throw error
      const driven = actual.driveSegment(...args)
      const force = forced.outcomes.shift()
      const forcedOutcome = force
        ? { ...driven, record: { ...driven.record, outcome: force(driven.record.outcome) } }
        : driven
      const replace = forced.records.shift()
      return replace ? { ...forcedOutcome, record: replace(forcedOutcome.record) } : forcedOutcome
    },
  }
}

/** A failure with the rover dead at `from + offset`. */
export function failAt(from: { x: number; y: number }, offset: { x: number; y: number }) {
  return (real: DriveOutcome): DriveOutcome => ({
    ...real,
    kind: 'failed',
    reasons: ['stuck'],
    endPose: { x: from.x + offset.x, y: from.y + offset.y, headingRad: real.endPose.headingRad },
  })
}

/** A stop short of the goal with the rover at `at`. */
export function stopShortAt(at: { x: number; y: number }) {
  return (real: DriveOutcome): DriveOutcome => ({
    ...real,
    kind: 'stopped-short',
    reasons: ['blocked'],
    endPose: { x: at.x, y: at.y, headingRad: real.endPose.headingRad },
  })
}
