import type { DriveEnding, DriveStatus } from '../drive/status'
import { roverStatus } from './map-objects'

/** What the public mission state says about the rover, dates as strings or not. */
export type RoverActivitySource = Parameters<typeof roverStatus>[0] & {
  /** An operator's pause; null while none lasts. */
  pause: object | null
}

/** The status of the drive in progress at its live edge, with its ending once it has one. */
export interface LiveDriveStatus {
  status: DriveStatus
  ending?: DriveEnding
}

/** What the rover is doing now, as a label and a shorter word for narrow viewports. */
export type RoverActivity =
  | { kind: 'drive'; status: DriveStatus; ending?: DriveEnding; label: string; short: string }
  | { kind: 'paused' | 'planning' | 'idle'; label: string; short: string }

const STATUS_WORDS: Record<DriveStatus, { label: string; short: string }> = {
  driving: { label: 'Driving', short: 'Driving' },
  steering: { label: 'Steering wheels', short: 'Steering' },
  turning: { label: 'Turning', short: 'Turning' },
  assessing: { label: 'Assessing', short: 'Assessing' },
  imaging: { label: 'Imaging', short: 'Imaging' },
  stopped: { label: 'Stopped', short: 'Stopped' },
}

const ENDING_WORDS: Record<DriveEnding, { label: string; short: string }> = {
  arrived: { label: 'Arrived', short: 'Arrived' },
  blocked: { label: 'Stopped short', short: 'Stopped' },
  hazard: { label: 'Hazard', short: 'Hazard' },
  stuck: { label: 'Stuck', short: 'Stuck' },
}

/**
 * What the rover is doing now, from the mission `state` and `live`, the status of the drive in
 * progress at its live edge (null until its first slice is in, which reads as driving). A drive
 * in progress comes first, since an operator's pause holds submissions and LGTMs, not the drive;
 * then the pause; then the planning phase (see {@link roverStatus}); else idle. Where playback
 * stands has no say: the activity is the rover's, not the visitor's.
 */
export function roverActivity(
  state: RoverActivitySource,
  live: LiveDriveStatus | null,
): RoverActivity {
  const phase = roverStatus(state)
  if (phase === 'driving') {
    const status = live?.status ?? 'driving'
    const ending = status === 'stopped' ? live?.ending : undefined
    const words = ending ? ENDING_WORDS[ending] : STATUS_WORDS[status]
    return { kind: 'drive', status, ...(ending && { ending }), ...words }
  }
  if (state.pause) return { kind: 'paused', label: 'Mission paused', short: 'Paused' }
  if (phase === 'planning') return { kind: 'planning', label: 'Planning phase', short: 'Planning' }
  return { kind: 'idle', label: 'Idle', short: 'Idle' }
}
