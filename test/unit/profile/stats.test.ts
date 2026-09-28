import { describe, expect, it } from 'vitest'
import type { ProfileSubmission } from '#shared/utils/profile'
import { profileStats } from '#shared/utils/profile'

const row = (fields: Partial<ProfileSubmission>): ProfileSubmission => ({
  id: 's',
  round: 1,
  createdAt: '2026-09-25T12:00:00.000Z',
  goalDistanceM: 80,
  likes: 1,
  ownLike: true,
  status: 'lost',
  drive: null,
  ...fields,
})

describe('profileStats', () => {
  it('is all zero without submissions', () => {
    expect(profileStats([])).toEqual({
      submissions: 0,
      wins: 0,
      drivenM: 0,
      lgtmsReceived: 0,
      deaths: 0,
    })
  })

  it('tallies wins, settled driving, deaths and LGTMs from others', () => {
    const rows = [
      row({ status: 'won', likes: 4, drive: { status: 'arrived', distanceM: 80.4 } }),
      row({ status: 'won', likes: 2, drive: { status: 'failed', distanceM: 41.6 } }),
      row({ status: 'won', likes: 3, drive: { status: 'stopped-short', distanceM: 12 } }),
      // Still playing: its distance and ending are not public yet.
      row({ status: 'won', likes: 5, drive: { status: 'driving' } }),
      row({ status: 'lost', likes: 1 }),
      // The author took back their own LGTM.
      row({ status: 'open', likes: 2, ownLike: false }),
    ]
    expect(profileStats(rows)).toEqual({
      submissions: 6,
      wins: 4,
      drivenM: 134,
      lgtmsReceived: 3 + 1 + 2 + 4 + 0 + 2,
      deaths: 1,
    })
  })
})
