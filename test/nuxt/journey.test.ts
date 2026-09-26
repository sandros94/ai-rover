import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { DriveJson } from '~/composables/useJourney'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SiteHeader from '~/components/SiteHeader.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DriveList from '~/components/journey/DriveList.vue'

const JUDGMENT: DriveJson['judgment'] = {
  feasible: 0.9,
  verdict: 'accept',
  risk: 1,
  distanceWeight: 1,
  timeWeight: 0.5,
  probabilities: {
    risk: [0.2, 0.7, 0.1, 0],
    distanceConfidence: [0, 0.1, 0.2, 0.7],
    timeConfidence: [0.1, 0.2, 0.6, 0.1],
  },
}

const DRIVES: DriveJson[] = [
  {
    id: '0192f000-0000-7000-8000-0000000000d2',
    number: 2,
    attempt: 1,
    status: 'failed',
    startedAt: '2026-09-25T14:00:00.000Z',
    endedAt: '2026-09-25T15:00:00.000Z',
    distanceM: 41.6,
    durationS: 1260,
    reasons: ['stuck'],
    from: { id: 's1', index: 1, x: 0, y: 80 },
    to: null,
    goal: { x: 30, y: 100 },
    death: { x: 30, y: 100 },
    submitter: { id: 'u1', displayName: 'Ada', avatarUrl: null },
    judgment: JUDGMENT,
    journeyBeforeM: 80,
  },
  {
    id: '0192f000-0000-7000-8000-0000000000d1',
    number: 1,
    attempt: 1,
    status: 'arrived',
    startedAt: '2026-09-25T12:00:00.000Z',
    endedAt: '2026-09-25T13:00:00.000Z',
    distanceM: 80,
    durationS: 2400,
    reasons: [],
    from: { id: 's0', index: 0, x: 0, y: 0 },
    to: { id: 's1', index: 1, x: 0, y: 80 },
    goal: { x: 0, y: 80 },
    death: null,
    submitter: { id: 'u2', displayName: 'Grace', avatarUrl: null },
    judgment: JUDGMENT,
    journeyBeforeM: 0,
  },
]

describe('DriveList', () => {
  it('renders one row per drive, linking to its replay', async () => {
    const wrapper = await mountSuspended(DriveList, { props: { drives: DRIVES } })
    const rows = wrapper.findAll('[data-test=drive]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('a').attributes('href')).toBe(`/drives/${DRIVES[0]!.id}`)
    const text = (k: number, field: string) => rows[k]!.find(`[data-test=drive-${field}]`).text()
    expect(text(0, 'number')).toBe('Leg 2')
    expect(text(0, 'route')).toBe('Stop 1 → lost')
    expect(text(0, 'status')).toMatch(/failed/i)
    expect(text(0, 'distance')).toBe('42 m')
    expect(text(0, 'submitter')).toBe('Ada')
    expect(text(1, 'route')).toBe('Stop 0 → stop 1')
    expect(text(1, 'status')).toMatch(/arrived/i)
    expect(rows[1]!.text()).toContain('40:00')
  })

  it('says so when no drive has ended', async () => {
    const wrapper = await mountSuspended(DriveList, { props: { drives: [] } })
    expect(wrapper.find('[data-test=drives-empty]').exists()).toBe(true)
  })
})

describe('SiteHeader', () => {
  it('links to the journey and the community', async () => {
    const wrapper = await mountSuspended(SiteHeader)
    expect(wrapper.find('[data-test=nav-journey]').attributes('href')).toBe('/drives')
    expect(wrapper.find('[data-test=nav-community]').attributes('href')).toBe('/community')
  })
})
