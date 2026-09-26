import type { DriveEvent, DriveEventType } from './segment'

/** What the rover is doing: moving, or stopped for a reason, or done. */
export type DriveStatus = 'driving' | 'turning' | 'assessing' | 'imaging' | 'stopped'

/** A status from sim time `t` until the next run starts. */
export interface StatusRun {
  t: number
  status: DriveStatus
  /** When a timed stop (turning, assessing, imaging) is due to end, seconds of sim time. */
  endsAt?: number
  /** Signed turn angle of a `turning` run, degrees, positive to the left. */
  angleDeg?: number
}

const TIMED: Partial<Record<DriveEventType, DriveStatus>> = {
  turning: 'turning',
  assessing: 'assessing',
  imaging: 'imaging',
}
const TERMINAL: ReadonlySet<DriveEventType> = new Set(['arrived', 'blocked', 'hazard', 'stuck'])

/**
 * The run-length status track of a drive, derived from its events: `driving` from `start`, each
 * stop event (`turning`, `assessing`, `imaging`) for its `durationS`, and `stopped` from the
 * terminal event on. A later event cuts a running stop short. Works on the events released so
 * far: a stop whose end has not been reached yet is still its last run.
 */
export function statusRuns(events: readonly DriveEvent[]): StatusRun[] {
  const runs: StatusRun[] = []
  const push = (run: StatusRun): void => {
    const last = runs.at(-1)
    if (last && last.t === run.t) runs.pop()
    const previous = runs.at(-1)
    if (previous?.status === run.status && run.status === 'driving') return
    runs.push(run)
  }
  let resumeAt: number | undefined
  for (const event of events) {
    if (runs.length === 0 && event.type !== 'start') continue
    if (runs.at(-1)?.status === 'stopped') break
    if (resumeAt !== undefined && resumeAt <= event.t) {
      push({ t: resumeAt, status: 'driving' })
      resumeAt = undefined
    }
    if (event.type === 'start') {
      push({ t: event.t, status: 'driving' })
    } else if (TERMINAL.has(event.type)) {
      resumeAt = undefined
      push({ t: event.t, status: 'stopped' })
    } else {
      const status = TIMED[event.type]
      if (!status) continue
      const durationS = event.details?.durationS
      const endsAt = event.t + (typeof durationS === 'number' ? durationS : 0)
      const angleDeg = event.details?.angleDeg
      push({
        t: event.t,
        status,
        endsAt,
        ...(status === 'turning' && typeof angleDeg === 'number' && { angleDeg }),
      })
      resumeAt = endsAt
    }
  }
  if (resumeAt !== undefined) runs.push({ t: resumeAt, status: 'driving' })
  return runs
}

/**
 * The status run holding sim time `t`: the last run starting at or before it. Before the drive
 * starts, `stopped` at 0.
 */
export function statusAt(events: readonly DriveEvent[], t: number): StatusRun {
  const runs = statusRuns(events)
  return runs.findLast((run) => run.t <= t) ?? { t: 0, status: 'stopped' }
}
