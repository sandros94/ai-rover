import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Component } from 'vue'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { UApp, USlider } from '#components'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
import { MAP_VIEW_KEY } from '~/composables/useMapView'
import { PANEL_LAYOUT_KEY } from '#shared/utils/client/hud'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import PlaybackControls from '~/components/dashboard/PlaybackControls.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import VoteCard from '~/components/dashboard/VoteCard.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneHud from '~/components/hud/SceneHud.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import NotMovingFlag from '~/components/dashboard/NotMovingFlag.vue'

/** An older stop's manifest key, named by its index. */
const stopKey = (index: number) =>
  `missions/0192f000-0000-7000-8000-000000000001/stops/${index}.json`

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
  deferred: false,
  goalInFog: false,
  exploration: 0.42,
  explorationParts: { pathInFog: 0.3, goalInFog: 0, pocket: 0 },
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
      manifestKey: stopKey(0),
      revealedKey: 'missions/0192f000-0000-7000-8000-000000000001/revealed/0.bin',
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
    flags: null,
    pause: null,
    lastSegment: null,
    trail: [{ index: 0, x: 0, y: 0, manifestKey: stopKey(0), reachedBy: null }],
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

/**
 * The stop's ground needs served terrain and a planner worker; the stub hands the layout what
 * `MissionMap` gives its slot: the stage's props and the pick flow.
 */
const planning = {
  result: undefined,
  pending: false,
  picked: false,
  submitting: false,
  refusal: null,
  onHover: () => {},
  onPick: () => {},
  confirm: () => {},
  cancel: () => {},
}
const MapStub = defineComponent({
  name: 'MissionMap',
  props: ['state', 'signedIn', 'highlight', 'track'],
  emits: ['submitted', 'stale', 'ground'],
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.({ stage: () => ({ center: { x: 0, y: 0 }, radius: 500 }), planning }),
})

/** The stage needs WebGL or a canvas; which view it shows, and where, is what matters here. */
const StageStub = defineComponent({
  name: 'StopStage',
  props: { view: { type: String, required: true } },
  setup: (props) => () => h('div', { 'data-test': 'stage', 'data-view': props.view }),
})

/** The HUD area, as laid out in a desktop browser. */
const AREA = { left: 0, top: 48, width: 1280, height: 720 }

/** `matchMedia` answering the layout's width query as a wide or a phone viewport would. */
function viewport(wide: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        matches: wide,
        media,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

/** Mounted with key listeners on the window: unmounted after each test. */
const attached: { unmount: () => void }[] = []

async function mountDashboard(props: {
  state: MissionStateJson | null
  error: unknown
  serverOffsetMs: number
}) {
  const wrapper = await mountSuspended(
    defineComponent({
      render: () => h(UApp, null, { default: () => h(MissionDashboard, props) }),
    }),
    { global: { stubs: { MissionMap: MapStub, StopStage: StageStub } }, attachTo: document.body },
  )
  attached.push(wrapper)
  return wrapper
}

const press = async (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }))
  await flushPromises()
}

const baseView = (wrapper: { find: (s: string) => { attributes: (a: string) => unknown } }) =>
  wrapper.find('[data-test=scene-layer] [data-test=stage]').attributes('data-view')

const inBody = (selector: string) => document.body.querySelector(selector)

beforeEach(() => {
  viewport(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...AREA,
    x: AREA.left,
    y: AREA.top,
    right: AREA.left + AREA.width,
    bottom: AREA.top + AREA.height,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  for (const wrapper of attached.splice(0)) wrapper.unmount()
  useState('rover-user-session').value = {}
  useState('ai-rover:panels').value = null
  useState('ai-rover:hud').value = { visible: true, instruments: false, vote: false }
  useMapFocus().clear()
  localStorage.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
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

  it('asks a signed-out visitor to sign in to LGTM', async () => {
    const wrapper = await mount(VoteCard, { ...props, signedIn: false })
    const like = wrapper.find('[data-test=like]')
    expect(like.attributes('href')).toBe('/login')
    expect(like.attributes('aria-label')).toBe('Sign in to LGTM')
    expect(like.text()).toContain('3')
  })

  it('names approvals LGTM, never likes', async () => {
    const wrapper = await mount(VoteCard, props)
    expect(wrapper.find('[data-test=like]').attributes('aria-label')).toBe('LGTM')
    expect(wrapper.text()).toContain('LGTM')
    expect(wrapper.text()).not.toMatch(/\blikes?\b/i)
  })

  it("says others take precedence over the driving author's pick", async () => {
    const plain = await mount(VoteCard, props)
    expect(plain.find('[data-test=deferred]').exists()).toBe(false)
    const deferred = await mount(VoteCard, {
      ...props,
      submission: { ...SUBMISSION, deferred: true },
    })
    expect(deferred.find('[data-test=deferred]').text()).toMatch(/others take precedence/i)
  })

  it('says the destination is unexplored when the goal lies in the fog', async () => {
    const plain = await mount(VoteCard, props)
    expect(plain.find('[data-test=goal-in-fog]').exists()).toBe(false)
    const fogged = await mount(VoteCard, {
      ...props,
      submission: { ...SUBMISSION, goalInFog: true },
    })
    expect(fogged.find('[data-test=goal-in-fog]').text()).toBe('destination unexplored')
  })

  it('shows the exploration value, its parts in words beside it, and keeps the risk', async () => {
    const wrapper = await mount(VoteCard, {
      ...props,
      submission: {
        ...SUBMISSION,
        exploration: 0.625,
        explorationParts: { pathInFog: 0.5, goalInFog: 1, pocket: 0.25 },
      },
    })
    const value = wrapper.find('[data-test=exploration]')
    expect(value.text()).toBe('Exploration 0.63')
    expect(value.attributes('aria-label')).toBe(
      "Exploration 0.63: Path in fog 0.50 · goal in fog 1.00 · pocket 0.25; averaged with Jev's own score",
    )
    expect(wrapper.findAll('[data-test=risk-level]')).toHaveLength(4)
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

  it('plays and pauses from one button that says which it will do', async () => {
    const wrapper = await mount(PlaybackControls, props)
    const toggle = wrapper.find('[data-test=play-toggle]')
    expect(toggle.attributes('aria-label')).toBe('Pause')
    await toggle.trigger('click')
    expect(wrapper.findComponent(PlaybackControls).emitted('toggle')).toHaveLength(1)
    const paused = await mount(PlaybackControls, { ...props, paused: true })
    expect(paused.find('[data-test=play-toggle]').attributes('aria-label')).toBe('Play')
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

  it('mounts on a fixture state with the scene, the round and the instruments', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=scene-layer] [data-test=stage]').exists()).toBe(true)
    expect(wrapper.find('[data-test=round]').exists()).toBe(true)
    expect(wrapper.find('[data-test=mission-clock]').exists()).toBe(false)
    await wrapper.find('[data-test=panels-menu]').trigger('click')
    await flushPromises()
    ;(inBody('[data-test=panel-toggle-journey]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.find('[data-test=journey-stats]').exists()).toBe(true)
  })

  it('shows the idle rover with nothing to vote on', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=round-empty]').text()).toMatch(/idle/i)
    expect(wrapper.find('[data-test=round-empty]').text()).toMatch(/5-minute planning phase/)
    expect(wrapper.find('[data-test=pause]').exists()).toBe(false)
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

  it('stands the cards by ranking score, each showing its score beside the LGTMs', async () => {
    const crowd = { ...SUBMISSION, id: 'crowd', likes: 100, exploration: 0 }
    const explorer = {
      ...SUBMISSION,
      id: 'explorer',
      likes: 25,
      exploration: 1,
      submitter: { ...ADA, id: 'someone-else' },
    }
    const withBoth = state({ round: { ...state().round!, submissions: [crowd, explorer] } })
    const wrapper = await mountDashboard({ state: withBoth, error: null, serverOffsetMs: 0 })
    const cards = wrapper.findAllComponents(VoteCard)
    // Both score 10; the higher exploration stands first.
    expect(cards.map((card) => card.props('submission').id)).toEqual(['explorer', 'crowd'])
    expect(cards.map((card) => card.find('[data-test=score]').text())).toEqual([
      'score 10.00',
      'score 10.00',
    ])
    expect(cards[0]!.find('[data-test=like]').text()).toContain('25 LGTM')
    expect(wrapper.find('[data-test=ranking]').text()).toMatch(/√LGTMs × \(1 \+ exploration\)/)
  })

  it('lets a signed-in user like and marks their own card', async () => {
    useState('rover-user-session').value = {
      user: { id: ADA.id, displayName: 'Ada', providers: ['github'] },
    }
    const withSubmission = state({
      round: { ...state().round!, submissions: [SUBMISSION] },
    })
    const wrapper = await mountDashboard({ state: withSubmission, error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=like]').element.tagName).toBe('BUTTON')
    expect(wrapper.findComponent(VoteCard).text()).toMatch(/yours/i)
  })

  it("shows an operator's pause with its message and who paused", async () => {
    const paused = state({
      pause: {
        message: 'Dust storm over the landing site.',
        by: { displayName: 'Op', avatarUrl: null },
        at: '2026-09-26T09:05:00.000Z',
      },
    })
    const wrapper = await mountDashboard({ state: paused, error: null, serverOffsetMs: 0 })
    const banner = wrapper.find('[data-test=pause]')
    expect(banner.text()).toContain('Dust storm over the landing site.')
    expect(banner.text()).toContain('Op')
  })
})

describe('NotMovingFlag', () => {
  const props = {
    segmentId: '0192f000-0000-7000-8000-0000000000g1',
    flags: { count: 1, quorum: 2 },
    signedIn: true,
  }

  it('shows the flags against the quorum and offers the flag', async () => {
    const wrapper = await mount(NotMovingFlag, props)
    expect(wrapper.find('[data-test=flag-count]').text()).toBe('1 / 2')
    expect(wrapper.find('[data-test=flag]').element.tagName).toBe('BUTTON')
    expect(wrapper.find('[data-test=flag]').text()).toMatch(/not moving/i)
  })

  it('asks a signed-out visitor to sign in to flag', async () => {
    const wrapper = await mount(NotMovingFlag, { ...props, signedIn: false })
    expect(wrapper.find('[data-test=flag]').attributes('href')).toBe('/login')
  })
})

describe('the full-viewport layout', () => {
  it('opens on the 3D scene and switches to the 2D map from the top bar', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(baseView(wrapper)).toBe('3d')
    await wrapper.find('[data-test=view-2d]').trigger('click')
    await flushPromises()
    expect(baseView(wrapper)).toBe('2d')
    expect(localStorage.getItem(MAP_VIEW_KEY)).toBe('2d')
  })

  it('plans on the 2D map from 3D, and returns to 3D after the submission', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=pick-preview]').exists()).toBe(false)
    await wrapper.find('[data-test=plan-on-map]').trigger('click')
    await flushPromises()
    expect(baseView(wrapper)).toBe('2d')
    expect(wrapper.find('[data-test=pick-preview]').exists()).toBe(true)
    expect(wrapper.find('[data-test=plan-on-map]').exists()).toBe(false)
    wrapper.findComponent(MapStub).vm.$emit('submitted')
    await flushPromises()
    expect(baseView(wrapper)).toBe('3d')
  })

  it('floats the default panels on a wide viewport, and closes and reopens one', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    const open = () => wrapper.findAll('[data-test=panel]').map((p) => p.attributes('data-panel'))
    // Attitude and speed open by default too, once a drive plays; none does here.
    expect(open()).toEqual(['map2d', 'vote'])
    expect(wrapper.find('[data-panel=map2d] [data-test=stage]').attributes('data-view')).toBe('2d')

    await wrapper.find('[data-panel=vote] [data-test=panel-close]').trigger('click')
    await flushPromises()
    expect(open()).not.toContain('vote')
    await vi.waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) ?? '{}')
      expect(saved.panels?.vote?.open).toBe(false)
    })

    await wrapper.find('[data-test=panels-menu]').trigger('click')
    await flushPromises()
    ;(inBody('[data-test=panel-toggle-vote]') as HTMLElement).click()
    await flushPromises()
    expect(open()).toContain('vote')
    expect(wrapper.find('[data-panel=vote] [data-test=round]').exists()).toBe(true)
  })

  it('offers no floating 2D map while the base view is the map', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    await wrapper.find('[data-test=view-2d]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-panel=map2d]').exists()).toBe(false)
  })

  it('hides the instruments on a phone until the toggle opens them in a drawer', async () => {
    viewport(false)
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-test=panel]').exists()).toBe(false)
    expect(inBody('[data-sheet=instruments]')).toBeNull()

    await wrapper.find('[data-test=hud-toggle]').trigger('click')
    await flushPromises()
    const sheet = inBody('[data-sheet=instruments]')
    expect(sheet?.querySelector('[data-test=mission-clock]')).not.toBeNull()
    expect(sheet?.querySelector('[data-test=journey-stats]')).not.toBeNull()
    expect(sheet?.querySelector('[data-test=round]')).toBeNull()

    await wrapper.find('[data-test=vote-toggle]').trigger('click')
    await flushPromises()
    expect(inBody('[data-sheet=vote] [data-test=round]')).not.toBeNull()
  })

  it('switches views with 1 and 2 and toggles the HUD with h', async () => {
    const wrapper = await mountDashboard({ state: state(), error: null, serverOffsetMs: 0 })
    await press('1')
    expect(baseView(wrapper)).toBe('2d')
    await press('2')
    expect(baseView(wrapper)).toBe('3d')
    expect(wrapper.find('[data-test=panel]').exists()).toBe(true)
    await press('h')
    expect(wrapper.find('[data-test=panel]').exists()).toBe(false)
    await press('h')
    expect(wrapper.find('[data-test=panel]').exists()).toBe(true)
  })
})

/** A mission one failure and one arrival in, with a pick waiting in the round. */
function inspected(): MissionStateJson {
  const base = state()
  return state({
    currentStop: { ...base.currentStop, index: 1, x: 0, y: 80 },
    trail: [
      { index: 0, x: 0, y: 0, manifestKey: stopKey(0), reachedBy: null },
      {
        index: 1,
        x: 0,
        y: 80,
        manifestKey: stopKey(1),
        reachedBy: {
          segmentId: 'seg-2',
          number: 2,
          fromIndex: 0,
          at: '2026-09-20T12:00:00.000Z',
        },
      },
    ],
    deaths: [
      {
        x: 30,
        y: 40,
        segmentId: 'seg-1',
        number: 1,
        fromIndex: 0,
        reasons: ['stuck'],
        at: '2026-09-19T12:00:00.000Z',
        distanceM: 42.25,
      },
    ],
    round: { ...base.round!, anchor: { x: 0, y: 80 }, submissions: [SUBMISSION] },
  } as Partial<MissionStateJson>)
}

describe('inspecting the map', () => {
  const details = () => document.body.querySelector('[data-test=object-details]')

  it('opens a detail panel for the focused death, with its replay and its death zone', async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    expect(wrapper.find('[data-panel=details]').exists()).toBe(false)
    useMapFocus().focusOn('death:seg-1')
    await flushPromises()
    const panel = wrapper.find('[data-panel=details]')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Segment 1')
    expect(panel.text()).toContain('stuck')
    expect(panel.find('[data-test=death-replay]').attributes('href')).toBe('/drives/seg-1')
    expect(panel.find('[data-test=death-zone]').text()).toContain('30 m')
  })

  it("shows a focused submission's judgment and draws its route", async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn(`submission:${SUBMISSION.id}`)
    await flushPromises()
    const panel = wrapper.find('[data-panel=details]')
    expect(panel.find('[data-test=verdict]').exists()).toBe(true)
    expect(panel.text()).toContain('Ada')
    expect(wrapper.findComponent(MapStub).props('highlight')).toEqual({
      id: SUBMISSION.id,
      goal: SUBMISSION.goal,
    })
  })

  it('lists the segments that left a focused stop', async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn('stop:0')
    await flushPromises()
    const links = wrapper
      .findAll('[data-panel=details] [data-test=stop-departure]')
      .map((link) => link.attributes('href'))
    expect(links).toEqual(['/drives/seg-1', '/drives/seg-2'])
  })

  it('clears the focus and closes the panel with Escape', async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn('death:seg-1')
    await flushPromises()
    await press('Escape')
    expect(useMapFocus().focused.value).toBeNull()
    expect(wrapper.find('[data-panel=details]').exists()).toBe(false)
  })

  it('clears the focus when the panel is closed', async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn('death:seg-1')
    await flushPromises()
    await wrapper.find('[data-panel=details] [data-test=panel-close]').trigger('click')
    await flushPromises()
    expect(useMapFocus().focused.value).toBeNull()
  })

  it('opens no panel for the rover: recentring leaves the instruments to it', async () => {
    const wrapper = await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn('death:seg-1')
    await flushPromises()
    useMapFocus().recentre()
    await flushPromises()
    expect(useMapFocus().focused.value).toBe('rover')
    expect(wrapper.find('[data-panel=details]').exists()).toBe(false)
  })

  it('drops a focus whose object is gone', async () => {
    const props = reactive({ state: inspected(), error: null, serverOffsetMs: 0 })
    await mountDashboard(props)
    useMapFocus().focusOn(`submission:${SUBMISSION.id}`)
    await flushPromises()
    // The round closed: its submissions are gone from the state.
    props.state = state({ round: null })
    await flushPromises()
    expect(useMapFocus().focused.value).toBeNull()
  })

  it('shows the details in a sheet on a phone', async () => {
    viewport(false)
    await mountDashboard({ state: inspected(), error: null, serverOffsetMs: 0 })
    useMapFocus().focusOn('death:seg-1')
    await flushPromises()
    expect(inBody('[data-sheet=details] [data-test=object-details]')).not.toBeNull()
    expect(details()?.textContent).toContain('stuck')
    expect(document.body.textContent).toContain('Segment 1: rover lost')
  })
})

describe('SceneHud', () => {
  async function mountHud(props: Record<string, unknown>) {
    const wrapper = await mountSuspended(
      defineComponent({
        setup() {
          const view = ref<'2d' | '3d'>('3d')
          return () =>
            h(UApp, null, {
              default: () =>
                h(SceneHud, {
                  'panels': [],
                  'view': view.value,
                  'onUpdate:view': (next: '2d' | '3d') => (view.value = next),
                  ...props,
                }),
            })
        },
      }),
      { attachTo: document.body },
    )
    attached.push(wrapper)
    return wrapper
  }

  it('plays and pauses with space and goes live with l', async () => {
    const wrapper = await mountHud({
      playback: { mode: 'replay', t: 12, rate: 1, paused: false, live: true },
    })
    const hud = wrapper.findComponent(SceneHud)
    await press(' ')
    expect(hud.emitted('toggle')).toHaveLength(1)
    await press('l')
    expect(hud.emitted('live')).toHaveLength(1)
  })

  it('ignores space and l without playback, and l on a replay with no live edge', async () => {
    const idle = await mountHud({ playback: null })
    await press(' ')
    await press('l')
    expect(idle.findComponent(SceneHud).emitted('toggle')).toBeUndefined()
    const replay = await mountHud({
      playback: { mode: 'replay', t: 12, rate: 60, paused: false, live: false },
    })
    await press('l')
    expect(replay.findComponent(SceneHud).emitted('live')).toBeUndefined()
  })

  it('lists the shortcuts in a help popover', async () => {
    const wrapper = await mountHud({ playback: null })
    await wrapper.find('[data-test=shortcuts]').trigger('click')
    await flushPromises()
    const help = inBody('[data-test=shortcuts-help]')
    expect(help?.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(5)
  })
})
