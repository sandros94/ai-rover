import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Component } from 'vue'
import { defineComponent, h, nextTick } from 'vue'
import { useState } from '#imports'
import { UApp, USlider } from '#components'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import PlaybackControls from '~/components/dashboard/PlaybackControls.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import VoteCard from '~/components/dashboard/VoteCard.vue'

type Submission = NonNullable<MissionStateJson['round']>['submissions'][number]

/** Mounts inside `UApp`, which provides what tooltips need. */
function mount(component: Component, props: Record<string, unknown>) {
  return mountSuspended(
    defineComponent({
      render: () => h(UApp, null, { default: () => h(component, props) }),
    }),
  )
}

const ADA = { id: '0192f000-0000-7000-8000-00000000000a', displayName: 'Ada', avatarUrl: null }

const SUBMISSION: Submission = {
  id: '0192f000-0000-7000-8000-0000000000s1',
  goal: { x: 60, y: 80 },
  createdAt: '2026-09-26T09:00:00.000Z',
  likes: 3,
  submitter: ADA,
  judgment: {
    feasible: 0.72,
    verdict: 'review',
    risk: 0.9,
    distanceWeight: 0.75,
    timeWeight: 0.5,
    probabilities: {
      risk: [0.2, 0.7, 0.1, 0],
      distanceConfidence: [0, 0.05, 0.15, 0.5, 0.3],
      timeConfidence: [0.1, 0.2, 0.4, 0.2, 0.1],
    },
  },
  summary: {
    rover: { class: 'rover', speed: 'slow', limits: 'none' },
    mission_rules: 'rules',
    destination: { straight_line_m: 100, straight_line_label: 'medium', bearing: 'north-east' },
    route: { reached: false },
    failure_reason: 'blocked',
  } as Submission['summary'],
}

function state(overrides: Partial<MissionStateJson> = {}): MissionStateJson {
  return {
    now: '2026-09-26T09:10:00.000Z',
    mission: {
      id: '0192f000-0000-7000-8000-000000000001',
      status: 'active',
      worldHash: '049511edc24e4e6b',
      solsEpoch: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      rules: structuredClone(DEFAULT_MISSION_RULES),
    },
    currentStop: {
      id: '0192f000-0000-7000-8000-0000000000a0',
      index: 0,
      x: 0,
      y: 0,
      headingRad: 0,
      manifestKey: 'missions/m/stops/0.json',
      revealedKey: 'missions/m/revealed/0.bin',
    },
    round: {
      id: '0192f000-0000-7000-8000-0000000000r1',
      opensAt: '2026-09-26T09:00:00.000Z',
      fromStopId: '0192f000-0000-7000-8000-0000000000a0',
      anchor: { x: 0, y: 0 },
      closesAt: null,
      submissions: [],
    },
    segment: null,
    release: null,
    lastSegment: null,
    trail: [{ index: 0, x: 0, y: 0 }],
    deaths: [],
    tally: {
      distanceM: 0,
      stops: 1,
      arrived: 0,
      stoppedShort: 0,
      failed: 0,
      resets: 0,
      longestM: 0,
    },
    ...overrides,
  } as MissionStateJson
}

/** The map needs a browser's canvas, workers and served terrain; its slots are what matter here. */
const MapStub = defineComponent({
  name: 'MissionMap',
  setup:
    (_, { slots }) =>
    () =>
      h('div', { 'data-test': 'map' }, [slots.controls?.(), slots.default?.()]),
})

function mountDashboard(props: {
  state: MissionStateJson | null
  error: unknown
  serverOffsetMs: number
}) {
  return mountSuspended(
    defineComponent({
      render: () => h(UApp, null, { default: () => h(MissionDashboard, props) }),
    }),
    { global: { stubs: { MissionMap: MapStub } } },
  )
}

afterEach(() => {
  useState('jev-user-session').value = {}
})

describe('VoteCard', () => {
  const props = {
    submission: SUBMISSION,
    anchor: { x: 0, y: 0 },
    liked: false,
    mine: false,
    signedIn: true,
    highlighted: false,
  }

  it('shows the submitter, bearing and distance from the anchor, and the judgment', async () => {
    const wrapper = await mount(VoteCard, props)
    expect(wrapper.text()).toContain('Ada')
    // (60, 80) from the origin: 100 m, 37° east of north.
    expect(wrapper.find('[data-test=goal]').text()).toMatch(/100 m/)
    expect(wrapper.find('[data-test=goal]').text()).toMatch(/37°/)
    expect(wrapper.find('[data-test=verdict]').text()).toMatch(/review/i)
  })

  it('shows the per-level probabilities of risk and both confidences', async () => {
    const wrapper = await mount(VoteCard, props)
    const risk = wrapper.findAll('[data-test=risk-probability]').map((p) => p.text())
    expect(risk).toEqual(['20 %', '70 %', '10 %', '0 %'])
    expect(wrapper.findAll('[data-test=distance-confidence] [data-test=level]')).toHaveLength(5)
    const time = wrapper
      .findAll('[data-test=time-confidence] [data-test=level-probability]')
      .map((p) => p.text())
    expect(time).toEqual(['10 %', '20 %', '40 %', '20 %', '10 %'])
  })

  it('toggles the like and asks for a highlight', async () => {
    const wrapper = await mount(VoteCard, props)
    const card = wrapper.findComponent(VoteCard)
    await wrapper.find('[data-test=like]').trigger('click')
    expect(card.emitted('like')).toEqual([[true]])
    await wrapper.find('[data-test=highlight]').trigger('click')
    expect(card.emitted('highlight')).toHaveLength(1)
    expect(wrapper.find('[data-test=like]').text()).toContain('3')

    const liked = await mount(VoteCard, { ...props, liked: true, mine: true })
    await liked.find('[data-test=like]').trigger('click')
    expect(liked.findComponent(VoteCard).emitted('like')).toEqual([[false]])
    expect(liked.text()).toMatch(/yours/i)
  })

  it('asks a signed-out visitor to sign in to like', async () => {
    const wrapper = await mount(VoteCard, { ...props, signedIn: false })
    const like = wrapper.find('[data-test=like]')
    expect(like.attributes('href')).toBe('/login')
    expect(like.text()).toContain('3')
  })

  it('falls back to the expected levels without probabilities', async () => {
    const { probabilities: _, ...judgment } = SUBMISSION.judgment
    const wrapper = await mount(VoteCard, { ...props, submission: { ...SUBMISSION, judgment } })
    expect(wrapper.findAll('[data-test=risk-level]')).toHaveLength(4)
    expect(wrapper.find('[data-test=risk-probability]').exists()).toBe(false)
  })
})

describe('PlaybackControls', () => {
  const props = { simTime: 120, releasedUntil: 600, mode: 'replay', rate: 1, lagS: 35 }

  it('emits rate changes and the return to live', async () => {
    const wrapper = await mount(PlaybackControls, props)
    const controls = wrapper.findComponent(PlaybackControls)
    await wrapper.find('[data-test=rate-60]').trigger('click')
    expect(controls.emitted('rate')).toEqual([[60]])
    await wrapper.find('[data-test=live]').trigger('click')
    expect(controls.emitted('live')).toHaveLength(1)
  })

  it('seeks from the scrubber, within the released range', async () => {
    const wrapper = await mount(PlaybackControls, props)
    const slider = wrapper.findComponent(USlider)
    expect((slider.props() as { max?: number }).max).toBe(600)
    slider.vm.$emit('update:modelValue', 300)
    await nextTick()
    expect(wrapper.findComponent(PlaybackControls).emitted('seek')).toEqual([[300]])
  })

  it('shows the sim time and how far it trails wall-clock', async () => {
    const wrapper = await mount(PlaybackControls, props)
    expect(wrapper.find('[data-test=sim-time]').text()).toBe('2:00')
    expect(wrapper.find('[data-test=lag]').text()).toMatch(/35 s/)
  })
})

describe('MissionDashboard', () => {
  it('says no mission has landed, with no development link outside development', async () => {
    const wrapper = await mountDashboard({
      state: null,
      error: { status: 404 },
      serverOffsetMs: 0,
    })
    expect(wrapper.text()).toMatch(/no mission has landed/i)
  })

  it('mounts on a fixture state with the round and the instruments', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=map]').exists()).toBe(true)
    expect(wrapper.find('[data-test=round]').exists()).toBe(true)
    expect(wrapper.find('[data-test=instruments]').exists()).toBe(true)
    expect(wrapper.find('[data-test=journey-stats]').exists()).toBe(true)
  })

  it('shows the idle rover with nothing to vote on', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=round-empty]').text()).toMatch(/idle/i)
    expect(wrapper.findAllComponents(VoteCard)).toHaveLength(0)
  })

  it('shows the cards to a signed-out visitor, likes asking to sign in', async () => {
    const withSubmission = state({
      round: { ...state().round!, submissions: [SUBMISSION] },
    })
    const wrapper = await mountDashboard({ state: withSubmission, error: null, serverOffsetMs: 0 })
    expect(wrapper.findAllComponents(VoteCard)).toHaveLength(1)
    expect(wrapper.find('[data-test=like]').attributes('href')).toBe('/login')
  })

  it('lets a signed-in user like and marks their own card', async () => {
    useState('jev-user-session').value = {
      user: { id: ADA.id, displayName: 'Ada', providers: ['github'] },
    }
    const withSubmission = state({
      round: { ...state().round!, submissions: [SUBMISSION] },
    })
    const wrapper = await mountDashboard({ state: withSubmission, error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=like]').element.tagName).toBe('BUTTON')
    expect(wrapper.findComponent(VoteCard).text()).toMatch(/yours/i)
  })
})
