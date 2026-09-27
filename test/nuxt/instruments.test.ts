import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Component } from 'vue'
import { defineComponent, h } from 'vue'
import { UApp } from '#components'
import type { DriveEvent, KeyframeBlock } from '#shared/utils/drive'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { NavMetrics } from '#shared/utils/nav'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import EventFeed from '~/components/instruments/EventFeed.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import JourneyStats from '~/components/instruments/JourneyStats.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionClock from '~/components/instruments/MissionClock.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import PlannerTelemetry from '~/components/instruments/PlannerTelemetry.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RevealMeter from '~/components/instruments/RevealMeter.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RootCountdown from '~/components/instruments/RoundCountdown.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverAttitude from '~/components/instruments/RoverAttitude.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SlipGauge from '~/components/instruments/SlipGauge.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SpeedOdometer from '~/components/instruments/SpeedOdometer.vue'

/** Mounts inside `UApp`, which provides what tooltips need. */
function mount(component: Component, options: { props: Record<string, unknown> }) {
  return mountSuspended(
    defineComponent({
      render: () => h(UApp, null, { default: () => h(component, options.props) }),
    }),
  )
}

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

function frameAt(values: Partial<Record<(typeof KEYFRAME_FIELDS)[number], number>> = {}) {
  const f = new Float32Array(KEYFRAME_STRIDE)
  f[field('qw')] = 1
  for (const [name, v] of Object.entries(values)) f[field(name as never)] = v
  return f
}

/** 200 frames at 2 Hz driving east 2 cm per frame with 20 % slip. */
function keyframes(): KeyframeBlock {
  const count = 200
  const data = new Float32Array(count * KEYFRAME_STRIDE)
  for (let k = 0; k < count; k++) {
    data.set(
      frameAt({
        t: k / 2,
        x: 0.02 * k,
        speed: 0.04,
        spinML: (0.025 * k) / 0.263,
        spinMR: (0.025 * k) / 0.263,
      }),
      k * KEYFRAME_STRIDE,
    )
  }
  return { hz: 2, stride: KEYFRAME_STRIDE, count, data }
}

const ev = (t: number, type: DriveEvent['type'], details?: DriveEvent['details']): DriveEvent => ({
  t,
  type,
  x: 0,
  y: 0,
  ...(details && { details }),
})
const EVENTS = [
  ev(0, 'start'),
  ev(0, 'turning', { angleDeg: 35, durationS: 35 / 3 }),
  ev(48, 'imaging', { durationS: 30 }),
  ev(90, 'slip', { slip: 0.4 }),
]

const METRICS: NavMetrics = {
  reached: true,
  pathLengthM: 162.4,
  straightLineM: 150,
  detourRatio: 1.083,
  maxSlopeDeg: 11.2,
  meanSlopeDeg: 4.1,
  unrevealedFraction: 0.35,
  goalInFog: false,
  estimatedDriveS: 5400,
  turnCount: 3,
  expansions: 5120,
  computeMs: 42,
}

describe('RoverAttitude', () => {
  it('draws six wheels in each view with readouts', async () => {
    const wrapper = await mount(RoverAttitude, { props: { frame: frameAt() } })
    expect(wrapper.findAll('[data-test=side-view] [data-test=wheel]')).toHaveLength(6)
    expect(wrapper.findAll('[data-test=rear-view] [data-test=wheel]')).toHaveLength(6)
    expect(wrapper.findAll('[data-test^=readout-]').map((r) => r.attributes('data-test'))).toEqual([
      'readout-pitch',
      'readout-roll',
      'readout-tilt',
      'readout-bogie-left',
      'readout-bogie-right',
      'readout-differential',
    ])
  })

  it('labels the side view as the right side, bogie before rocker', async () => {
    const wrapper = await mount(RoverAttitude, { props: { frame: frameAt() } })
    const caption = wrapper.find('[data-test=side-view] + figcaption').text()
    expect(caption.replace(/\s+/g, ' ')).toBe('Side, right · bogie rocker')
  })

  it('turns the wheel treads with the wheel spin', async () => {
    const tread = async (spin: number) => {
      const wrapper = await mount(RoverAttitude, {
        props: {
          frame: frameAt({
            spinFL: spin,
            spinFR: spin,
            spinML: spin,
            spinMR: spin,
            spinRL: spin,
            spinRR: spin,
          }),
        },
      })
      return wrapper.find('[data-test=side-view] [data-test=tread]').attributes('transform')
    }
    expect(await tread(0)).not.toBe(await tread(1.2))
  })

  it('flags a readout past its limit', async () => {
    const wrapper = await mount(RoverAttitude, {
      props: { frame: frameAt({ rockerL: 0.2, rockerR: -0.2 }) },
    })
    expect(wrapper.find('[data-test=readout-differential]').attributes('data-level')).toBe('warn')
    expect(wrapper.find('[data-test=readout-pitch]').attributes('data-level')).toBe('ok')
  })
})

describe('SpeedOdometer', () => {
  it('shows actual against commanded speed, odometers and efficiency', async () => {
    const wrapper = await mount(SpeedOdometer, {
      props: {
        frame: frameAt({ t: 50, speed: 0.03 }),
        events: EVENTS,
        keyframes: keyframes(),
        missionBeforeM: 120,
      },
    })
    expect(wrapper.find('[data-test=speed-actual]').exists()).toBe(true)
    expect(wrapper.find('[data-test=speed-commanded]').exists()).toBe(true)
    expect(wrapper.find('[data-test=odometer-segment]').text()).toContain('2.00')
    expect(wrapper.find('[data-test=odometer-mission]').text()).toContain('122')
    expect(wrapper.find('[data-test=efficiency]').text()).toContain('%')
  })

  it('labels efficiency against the commanded cap', async () => {
    const wrapper = await mount(SpeedOdometer, {
      props: { frame: frameAt({ t: 50, speed: 0 }), events: EVENTS, keyframes: keyframes() },
    })
    expect(wrapper.find('[data-test=efficiency]').text()).toContain('vs commanded cap')
  })

  it.each([
    [5, 'turning', 'turning 35°'],
    [30, 'driving', 'driving'],
    [66, 'imaging', 'imaging stop 12 s'],
  ])('says what the rover is doing at t = %s', async (t, status, text) => {
    const wrapper = await mount(SpeedOdometer, {
      props: { frame: frameAt({ t, speed: 0 }), events: EVENTS, keyframes: keyframes() },
    })
    const badge = wrapper.find('[data-test=drive-status]')
    expect(badge.attributes('data-status')).toBe(status)
    expect(badge.text()).toBe(text)
  })

  it('says assessing during an assessment stop and stopped after the drive', async () => {
    const events = [ev(0, 'start'), ev(40, 'assessing', { durationS: 20, cause: 'revealed' })]
    const at = async (t: number, list: DriveEvent[]) =>
      (
        await mount(SpeedOdometer, {
          props: { frame: frameAt({ t, speed: 0 }), events: list, keyframes: keyframes() },
        })
      )
        .find('[data-test=drive-status]')
        .text()
    expect(await at(45, events)).toBe('assessing')
    expect(await at(80, [...events, ev(70, 'arrived')])).toBe('stopped')
  })
})

describe('MissionClock', () => {
  it('shows sol, LMST, wall-clock, drive time and live lag', async () => {
    const epoch = Date.UTC(2026, 8, 1)
    const wrapper = await mount(MissionClock, {
      props: {
        solsEpoch: new Date(epoch).toISOString(),
        nowMs: epoch + 88_775_244 * 2.5,
        segmentStartedAt: epoch,
        simTime: 90,
      },
    })
    expect(wrapper.find('[data-test=sol]').text()).toContain('2')
    expect(wrapper.find('[data-test=lmst]').text()).toContain('12:00')
    expect(wrapper.find('[data-test=wall-clock]').exists()).toBe(true)
    expect(wrapper.find('[data-test=drive-time]').text()).toContain('1:30')
    expect(wrapper.find('[data-test=live-lag]').exists()).toBe(true)
  })
})

describe('EventFeed', () => {
  it('lists every event newest first, stops with their details', async () => {
    const wrapper = await mount(EventFeed, { props: { events: EVENTS, t: 100 } })
    const items = wrapper.findAll('[data-test=event]')
    expect(items).toHaveLength(4)
    expect(items[0]!.text()).toMatch(/slip/i)
    expect(items[1]!.text()).toContain('Imaging stop')
    expect(items[1]!.text()).toContain('30 s')
    expect(items[2]!.text()).toContain('Turning')
    expect(items[2]!.text()).toContain('35° left')
    expect(items[1]!.find('[data-test=event-icon]').attributes('data-icon')).toBe('i-lucide-camera')
  })
})

describe('SlipGauge', () => {
  it('shows the slip over the last metre on a wheel track', async () => {
    const wrapper = await mount(SlipGauge, { props: { keyframes: keyframes(), t: 90 } })
    expect(wrapper.find('[data-test=slip-track]').exists()).toBe(true)
    expect(wrapper.find('[data-test=slip-value]').text()).toContain('20')
    expect(wrapper.find('[data-test=slip-track]').attributes('data-level')).toBe('ok')
  })
})

describe('RevealMeter', () => {
  it('shows drive and journey area with a sparkline', async () => {
    const reveals = [
      { t: 0, vertices: new Uint32Array(1000) },
      { t: 70, vertices: new Uint32Array(200) },
    ]
    const wrapper = await mount(RevealMeter, {
      props: { reveals, t: 100, cellSize: 1, journeyBeforeM2: 5000 },
    })
    expect(wrapper.find('[data-test=reveal-drive]').text()).toContain('1,200')
    expect(wrapper.find('[data-test=reveal-journey]').text()).toContain('6,200')
    expect(wrapper.find('[data-test=sparkline]').exists()).toBe(true)
  })
})

describe('PlannerTelemetry', () => {
  it('shows the metrics and a slope profile', async () => {
    const profile = {
      lengthM: 20,
      samples: [
        { distanceM: 0, slopeDeg: 2 },
        { distanceM: 10, slopeDeg: 5 },
        { distanceM: 20, slopeDeg: null },
      ],
    }
    const wrapper = await mount(PlannerTelemetry, {
      props: { metrics: METRICS, profile, slopeLimitDeg: 16 },
    })
    expect(wrapper.findAll('[data-test=metric]').length).toBeGreaterThanOrEqual(8)
    expect(wrapper.find('[data-test=profile-seen]').exists()).toBe(true)
    expect(wrapper.find('[data-test=profile-unseen]').exists()).toBe(true)
  })
})

describe('JudgmentCard', () => {
  it('shows feasibility, risk levels, both confidences and the verdict', async () => {
    const wrapper = await mount(JudgmentCard, {
      props: {
        judgment: {
          feasible: 0.72,
          verdict: 'review',
          risk: 1.4,
          distanceWeight: 0.6,
          timeWeight: 0.45,
        },
      },
    })
    expect(wrapper.find('[data-test=feasible]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test=risk-level]')).toHaveLength(4)
    expect(wrapper.findAll('[data-test=distance-confidence] [data-test=level]')).toHaveLength(5)
    expect(wrapper.findAll('[data-test=time-confidence] [data-test=level]')).toHaveLength(5)
    expect(wrapper.find('[data-test=verdict]').text()).toMatch(/review/i)
  })
})

describe('RoundCountdown', () => {
  it('rings the planning phase with the leader LGTMs', async () => {
    const now = Date.UTC(2026, 8, 26)
    const wrapper = await mount(RootCountdown, {
      props: {
        round: {
          closesAt: new Date(now + 90_000).toISOString(),
          submissions: [
            {
              id: 'a',
              likes: 4,
              submitter: { id: 'u1' },
              deferred: false,
              createdAt: new Date(now).toISOString(),
              judgment: { risk: 1, distanceWeight: 0.5, timeWeight: 0.5 },
            },
          ],
        },
        driving: false,
        nowMs: now,
        rules: DEFAULT_MISSION_RULES,
      },
    })
    expect(wrapper.find('[data-test=ring]').exists()).toBe(true)
    expect(wrapper.find('[data-test=remaining]').text()).toContain('1:30')
    expect(wrapper.find('[data-test=leader-likes]').text()).toContain('4')
    expect(wrapper.text()).toContain('Planning phase')
    expect(wrapper.text()).toContain('LGTM on the leading pick')
    expect(wrapper.text()).not.toMatch(/grace|like/i)
  })

  it('names the idle state', async () => {
    const wrapper = await mount(RootCountdown, {
      props: { round: null, driving: false, nowMs: 0, rules: DEFAULT_MISSION_RULES },
    })
    expect(wrapper.text()).toMatch(/rover idle/i)
  })
})

describe('JourneyStats', () => {
  it('shows a tile per stat', async () => {
    const wrapper = await mount(JourneyStats, {
      props: {
        tally: {
          distanceM: 1234.5,
          stops: 9,
          arrived: 6,
          stoppedShort: 2,
          failed: 1,
          resets: 0,
          longestM: 248,
        },
      },
    })
    expect(wrapper.findAll('[data-test=stat]')).toHaveLength(7)
    expect(wrapper.text()).toContain('1,235')
  })
})
