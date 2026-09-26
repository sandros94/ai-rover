import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { UApp } from '#components'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { DriveJson } from '~/composables/useJourney'
import { REPLAYED_UNTIL_KEY, useReplayedUntil } from '~/composables/useReplayedUntil'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import ReplayPage from '~/pages/drives/replay.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DriveReplay from '~/components/journey/DriveReplay.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import ReplayBar from '~/components/journey/ReplayBar.vue'

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

const MISSION_ID = '0192f000-0000-7000-8000-000000000001'

/** Two consecutive settled segments, oldest first as a playlist plays them. */
const DRIVES: DriveJson[] = [
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
]

const MISSION = {
  id: MISSION_ID,
  solsEpoch: '2026-09-01T00:00:00.000Z',
  rules: structuredClone(DEFAULT_MISSION_RULES),
}

/** Every query the range endpoint was asked, as its search string. */
const asked: string[] = []
registerEndpoint('/api/mission/segments', (event: { path?: string; url?: URL }) => {
  asked.push(String(event.url?.search ?? event.path ?? ''))
  return { drives: DRIVES, page: 1, pageSize: 50, total: 2 }
})
registerEndpoint(`/api/mission/segments/${DRIVES[0]!.id}`, () => ({
  drive: DRIVES[0],
  mission: MISSION,
  trail: [{ index: 0, x: 0, y: 0 }],
  next: { id: DRIVES[1]!.id, number: 2 },
}))

/** The stage needs WebGL or a canvas; the layout around it is what matters here. */
const StageStub = defineComponent({
  name: 'LiveStage',
  props: ['stage', 'view'],
  setup: (props) => () => h('div', { 'data-test': 'stage', 'data-view': props.view }),
})

const attached: { unmount: () => void }[] = []

const press = async (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }))
  await flushPromises()
}

const indicator = () => document.body.querySelector('[data-test=segment-indicator]')

beforeEach(() => {
  asked.length = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
})

afterEach(() => {
  for (const wrapper of attached.splice(0)) wrapper.unmount()
  useState('jev-rover:hud').value = { visible: true, instruments: false, vote: false }
  localStorage.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the multi-segment replay page', () => {
  it('mounts over a two-segment range and shows which segment of how many plays', async () => {
    const wrapper = await mountSuspended(ReplayPage, {
      route: '/drives/replay?from=1&to=2',
      global: { stubs: { LiveStage: StageStub } },
      attachTo: document.body,
    })
    attached.push(wrapper)
    await vi.waitFor(() => expect(indicator()).not.toBeNull())
    expect(asked.some((q) => q.includes('from=1') && q.includes('to=2'))).toBe(true)
    const text = indicator()!.textContent!
    expect(text).toContain('Segment 1')
    expect(text).toContain('1 of 2')
    expect(text).toContain('Stop 0 → stop 1')
  })
})

describe('DriveReplay', () => {
  async function mountReplay(props: InstanceType<typeof DriveReplay>['$props']) {
    const wrapper = await mountSuspended(
      defineComponent({ render: () => h(UApp, null, { default: () => h(DriveReplay, props) }) }),
      { global: { stubs: { LiveStage: StageStub } }, attachTo: document.body },
    )
    attached.push(wrapper)
    return wrapper
  }

  it('jumps between segments with n and p, swapping the indicator', async () => {
    await mountReplay({ drives: DRIVES, mission: MISSION, trail: [{ index: 0, x: 0, y: 0 }] })
    expect(indicator()!.textContent).toContain('1 of 2')
    await press('n')
    expect(indicator()!.textContent).toContain('2 of 2')
    expect(indicator()!.textContent).toContain('Segment 2')
    expect(indicator()!.textContent).toContain('Stop 1 → lost')
    // Past the last segment there is nowhere to go.
    await press('n')
    expect(indicator()!.textContent).toContain('2 of 2')
    await press('p')
    expect(indicator()!.textContent).toContain('1 of 2')
  })

  it('plays a single segment without the indicator and links to the next one', async () => {
    const wrapper = await mountReplay({
      drives: [DRIVES[0]!],
      mission: MISSION,
      trail: [{ index: 0, x: 0, y: 0 }],
      next: { to: `/drives/${DRIVES[1]!.id}`, number: 2 },
    })
    expect(indicator()).toBeNull()
    expect(wrapper.find('h1').text()).toBe('Segment 1')
    const next = wrapper.find('[data-test=next-segment]')
    expect(next.attributes('href')).toBe(`/drives/${DRIVES[1]!.id}`)
    expect(next.text()).toMatch(/segment 2/i)
  })
})

describe('ReplayBar', () => {
  const NOW = new Date('2026-09-26T12:00:00.000Z')

  async function mountBar() {
    const wrapper = await mountSuspended(
      defineComponent({
        render: () => h(UApp, null, { default: () => h(ReplayBar, { latest: 12 }) }),
      }),
    )
    attached.push(wrapper)
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  const hrefOf = (wrapper: Awaited<ReturnType<typeof mountBar>>, name: string) =>
    new URL(wrapper.find(`[data-test=replay-${name}]`).attributes('href')!, 'http://x')

  it('offers the last day and week, and a range of segment numbers ending at the latest', async () => {
    const wrapper = await mountBar()
    const day = hrefOf(wrapper, 'day')
    expect(day.pathname).toBe('/drives/replay')
    expect(day.searchParams.get('since')).toBe('2026-09-25T12:00:00.000Z')
    expect(hrefOf(wrapper, 'week').searchParams.get('since')).toBe('2026-09-19T12:00:00.000Z')
    const range = hrefOf(wrapper, 'range')
    expect(range.searchParams.get('from')).toBe('8')
    expect(range.searchParams.get('to')).toBe('12')
    // Nothing replayed yet on this browser: no "since last visit".
    expect(wrapper.find('[data-test=replay-last-visit]').exists()).toBe(false)
  })

  it('offers what ended since the last replay once one completed', async () => {
    localStorage.setItem(REPLAYED_UNTIL_KEY, '2026-09-26T08:00:00.000Z')
    const wrapper = await mountBar()
    expect(hrefOf(wrapper, 'last-visit').searchParams.get('since')).toBe('2026-09-26T08:00:00.000Z')
  })
})

describe('useReplayedUntil', () => {
  it('only ever moves the mark forward', async () => {
    let replayed!: ReturnType<typeof useReplayedUntil>
    const wrapper = await mountSuspended(
      defineComponent({
        setup() {
          replayed = useReplayedUntil()
          return () => h('div')
        },
      }),
    )
    attached.push(wrapper)
    await flushPromises()
    expect(replayed.until.value).toBeNull()
    replayed.mark('2026-09-25T15:00:00.000Z')
    expect(localStorage.getItem(REPLAYED_UNTIL_KEY)).toBe('2026-09-25T15:00:00.000Z')
    replayed.mark('2026-09-25T13:00:00.000Z')
    expect(localStorage.getItem(REPLAYED_UNTIL_KEY)).toBe('2026-09-25T15:00:00.000Z')
    expect(replayed.until.value).toBe('2026-09-25T15:00:00.000Z')
  })
})
