import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import CommunityPage from '~/pages/community.vue'

const MEMBERS = [
  {
    user: { id: 'u1', displayName: 'Ada', avatarUrl: null },
    won: 2,
    lgtmsReceived: 3,
    distanceM: 122.4,
    failures: 1,
  },
  {
    user: { id: 'u2', displayName: 'Grace', avatarUrl: 'https://example.com/g.png' },
    won: 0,
    lgtmsReceived: 1,
    distanceM: 0,
    failures: 0,
  },
]

registerEndpoint('/api/community', () => ({ members: MEMBERS }))

describe('community page', () => {
  it('renders one row per member with their tallies, in the order given', async () => {
    const wrapper = await mountSuspended(CommunityPage)
    const rows = wrapper.findAll('[data-test=member]')
    expect(rows).toHaveLength(2)
    const cell = (k: number, field: string) => rows[k]!.find(`[data-test=member-${field}]`).text()
    expect(cell(0, 'name')).toBe('Ada')
    expect(cell(0, 'distance')).toBe('122 m')
    expect(cell(0, 'won')).toBe('2')
    expect(cell(0, 'lgtms')).toBe('3')
    expect(cell(0, 'failures')).toBe('1')
    expect(cell(1, 'name')).toBe('Grace')
    expect(wrapper.text()).toContain('LGTMs received')
  })
})
