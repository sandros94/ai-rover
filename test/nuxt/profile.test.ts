import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import ProfilePage from '~/pages/u/[id].vue'

const ID = '0192f000-0000-7000-8000-00000000000a'

registerEndpoint('/api/_auth/session', () => ({}))
registerEndpoint(`/api/users/${ID}`, () => ({
  user: {
    id: ID,
    displayName: 'Ada',
    avatarUrl: null,
    providers: ['github', 'discord'],
    memberSince: '2026-09-01T00:00:00.000Z',
  },
  submissions: [
    {
      id: 's2',
      round: 2,
      createdAt: '2026-09-25T14:00:00.000Z',
      goalDistanceM: 61.7,
      likes: 3,
      ownLike: true,
      status: 'won',
      drive: { status: 'failed', distanceM: 42.2 },
    },
    {
      id: 's1',
      round: 1,
      createdAt: '2026-09-25T12:00:00.000Z',
      goalDistanceM: 80,
      likes: 1,
      ownLike: true,
      status: 'lost',
      drive: null,
    },
  ],
  stats: { submissions: 2, wins: 1, drivenM: 42.2, lgtmsReceived: 2, deaths: 1 },
}))

describe('profile page', () => {
  it('shows the identity card, the stats and each submission with its outcome', async () => {
    const wrapper = await mountSuspended(ProfilePage, { route: `/u/${ID}` })
    expect(wrapper.find('[data-test=profile-name]').text()).toBe('Ada')
    expect(wrapper.find('[data-test=profile-provider-github]').exists()).toBe(true)
    expect(wrapper.find('[data-test=profile-provider-discord]').exists()).toBe(true)
    expect(wrapper.find('[data-test=profile-provider-atproto]').exists()).toBe(false)
    expect(wrapper.find('[data-test=profile-since]').text()).toContain('2026')
    expect(wrapper.find('[data-test=stat-driven]').text()).toBe('42 m')
    expect(wrapper.find('[data-test=stat-wins]').text()).toBe('1')
    expect(wrapper.find('[data-test=stat-lgtms]').text()).toBe('2')
    expect(wrapper.find('[data-test=stat-deaths]').text()).toBe('1')

    const rows = wrapper.findAll('[data-test=profile-submission]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Round 2')
    expect(rows[0]!.find('[data-test=submission-distance]').text()).toBe('62 m')
    expect(rows[0]!.find('[data-test=submission-likes]').text()).toBe('3 LGTMs')
    expect(rows[0]!.find('[data-test=submission-status]').text()).toBe('Won')
    expect(rows[0]!.find('[data-test=submission-drive]').text()).toBe('Failed')
    expect(rows[1]!.find('[data-test=submission-status]').text()).toBe('Lost')
    expect(rows[1]!.find('[data-test=submission-drive]').exists()).toBe(false)
  })

  it('says so for an unknown user', async () => {
    const wrapper = await mountSuspended(ProfilePage, {
      route: '/u/0192f000-0000-7000-8000-0000000000ff',
    })
    expect(wrapper.find('[data-test=profile-missing]').exists()).toBe(true)
  })
})
