/**
 * A submission as a public profile lists it: only what its vote card showed, and how it ended
 * once that is public.
 */
export interface ProfileSubmission {
  id: string
  /** The round's place in its mission, from 1. */
  round: number
  createdAt: string | Date
  /** Straight-line distance from where the round was measured to the goal, metres. */
  goalDistanceM: number
  /** LGTMs, the author's own included, as the vote card counts them. */
  likes: number
  /** Whether the author's own LGTM is among `likes`. */
  ownLike: boolean
  status: 'open' | 'won' | 'lost'
  /** The drive to the goal, once it won; its ending only after the drive settled. */
  drive: null | { status: 'driving' } | { status: SettledDriveStatus; distanceM: number }
}

export type SettledDriveStatus = 'arrived' | 'stopped-short' | 'failed'

export interface ProfileStats {
  submissions: number
  wins: number
  /** Ground the rover covered on their settled drives, failures included, metres. */
  drivenM: number
  /** LGTMs other users gave their submissions. */
  lgtmsReceived: number
  /** Their settled drives that failed. */
  deaths: number
}

export function profileStats(submissions: readonly ProfileSubmission[]): ProfileStats {
  const stats: ProfileStats = { submissions: 0, wins: 0, drivenM: 0, lgtmsReceived: 0, deaths: 0 }
  for (const s of submissions) {
    stats.submissions++
    if (s.status === 'won') stats.wins++
    stats.lgtmsReceived += s.likes - (s.ownLike ? 1 : 0)
    if (s.drive && s.drive.status !== 'driving') {
      stats.drivenM += s.drive.distanceM
      if (s.drive.status === 'failed') stats.deaths++
    }
  }
  return stats
}
