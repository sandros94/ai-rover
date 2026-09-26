import type { Component, PropType } from 'vue'
import { computed } from 'vue'
import type { DriveEvent, SegmentRecord } from '#shared/utils/drive'
import type { DiskWire } from '../../shared/disk-wire'
import type { PlaygroundContext } from './fixtures'

/** What an entry needs from the frame beyond the time scrubber. */
export type PlaygroundNeed = 'record' | 'disk'

/**
 * Props every playground component receives from the frame, as a runtime declaration: the SFC
 * compiler cannot resolve a props type imported from another file under TypeScript 7.
 */
export const PLAYGROUND_PROPS = {
  record: { type: Object as PropType<SegmentRecord>, required: true },
  /** The 19 keyframe values at the scrub time, as `interpolatePose` returns them. */
  frame: { type: Float32Array, required: true },
  /** Record events at or before the scrub time. */
  events: { type: Array as PropType<DriveEvent[]>, required: true },
  /** The stop disk at the record's start; present when the entry needs `disk`. */
  disk: { type: Object as PropType<DiskWire>, default: undefined },
} as const

/**
 * The record's reveal groups reached by time `t`, as a playing drive holds them: a new array
 * only when another group is reached, so scrubbing between reveals redraws no fog.
 */
export function useRevealsUntil(record: () => SegmentRecord, t: () => number) {
  const count = computed(() => {
    const reveals = record().reveals
    const now = t()
    let n = 0
    while (n < reveals.length && reveals[n]!.t <= now) n++
    return n
  })
  return computed(() => record().reveals.slice(0, count.value))
}

export interface PlaygroundEntry {
  /** URL segment under `/_dev/playground/`. */
  id: string
  title: string
  group: 'instrument' | 'scene' | 'card'
  component: () => Promise<{ default: Component }>
  needs: PlaygroundNeed[]
  /** The component's props from the frame's context; without it, {@link PLAYGROUND_PROPS}. */
  bind?: (context: PlaygroundContext) => Record<string, unknown>
}

/** An app instrument shown on its own, fed from the fixture drive. */
function instrument(
  id: string,
  title: string,
  component: PlaygroundEntry['component'],
  bind: NonNullable<PlaygroundEntry['bind']>,
  needs: PlaygroundNeed[] = ['record'],
): PlaygroundEntry {
  return { id, title, group: 'instrument', component, needs, bind }
}

export const PLAYGROUND_ENTRIES: PlaygroundEntry[] = [
  instrument(
    'rover-attitude',
    'Rover attitude',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/RoverAttitude.vue'),
    (c) => ({ frame: c.frame }),
  ),
  instrument(
    'speed-odometer',
    'Speed and odometer',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/SpeedOdometer.vue'),
    (c) => ({
      frame: c.frame,
      events: c.events,
      keyframes: c.record.keyframes,
      missionBeforeM: c.tally.distanceM,
    }),
  ),
  instrument(
    'mission-clock',
    'Mission clock',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/MissionClock.vue'),
    (c) => ({
      solsEpoch: c.solsEpoch,
      nowMs: c.nowMs,
      segmentStartedAt: c.segmentStartedAt,
      simTime: c.t,
    }),
  ),
  instrument(
    'event-feed',
    'Event feed',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/EventFeed.vue'),
    (c) => ({ events: c.events, t: c.t }),
  ),
  instrument(
    'slip-gauge',
    'Slip gauge',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/SlipGauge.vue'),
    (c) => ({ keyframes: c.record.keyframes, t: c.t }),
  ),
  instrument(
    'reveal-meter',
    'Reveal meter',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/RevealMeter.vue'),
    (c) => ({
      reveals: c.record.reveals,
      t: c.t,
      cellSize: c.cellSize,
      journeyBeforeM2: c.journeyBeforeM2,
    }),
    ['disk', 'record'],
  ),
  instrument(
    'planner-telemetry',
    'Planner telemetry',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/PlannerTelemetry.vue'),
    (c) => ({ metrics: c.metrics, profile: c.profile, slopeLimitDeg: c.slopeLimitDeg }),
    ['disk', 'record'],
  ),
  instrument(
    'judgment-card',
    'Judgment card',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/JudgmentCard.vue'),
    (c) => ({ judgment: c.judgment }),
  ),
  instrument(
    'round-countdown',
    'Round countdown',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/RoundCountdown.vue'),
    (c) => c.round,
  ),
  instrument(
    'journey-stats',
    'Journey stats',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('~/components/instruments/JourneyStats.vue'),
    (c) => ({ tally: c.tally }),
  ),
  instrument(
    'rover-model',
    'Rover model (3D)',
    () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('../components/playground/RoverModel3D.vue'),
    (c) => ({ frame: c.frame }),
  ),
  {
    id: 'stop-map',
    title: 'Stop map',
    group: 'scene',
    component: () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('../components/playground/StopMapScene.vue'),
    needs: ['disk', 'record'],
  },
  {
    id: 'stop-scene',
    title: 'Stop scene (3D)',
    group: 'scene',
    component: () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('../components/playground/StopScene3D.vue'),
    needs: ['disk', 'record'],
  },
  {
    id: 'pick-preview',
    title: 'Pick preview',
    group: 'card',
    component: () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('../components/playground/PickPreviewCard.vue'),
    needs: ['disk', 'record'],
  },
]
