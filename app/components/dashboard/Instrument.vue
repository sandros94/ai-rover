<script lang="ts">
/** Closed set: the instrument panels, as `PANEL_IDS` names them. */
export type InstrumentGroup =
  | 'clock'
  | 'attitude'
  | 'speed'
  | 'slip'
  | 'events'
  | 'reveals'
  | 'planner'
  | 'journey'

export const INSTRUMENT_GROUPS: readonly InstrumentGroup[] = [
  'clock',
  'attitude',
  'speed',
  'slip',
  'events',
  'reveals',
  'planner',
  'journey',
]

/** The groups that read a playing drive. */
export const DRIVE_GROUPS: readonly InstrumentGroup[] = [
  'attitude',
  'speed',
  'slip',
  'events',
  'reveals',
  'planner',
]
</script>

<script setup lang="ts">
import type { RevealGroup, RoundSubmission, SlopeProfile } from '#shared/utils/client/instruments'
import type { DriveEvent, KeyframeBlock } from '#shared/utils/drive'
import type { MissionRules } from '#shared/utils/mission'
import type { NavMetrics } from '#shared/utils/nav'
import EventFeed from '~/components/instruments/EventFeed.vue'
import type { JourneyTally } from '~/components/instruments/JourneyStats.vue'
import JourneyStats from '~/components/instruments/JourneyStats.vue'
import MissionClock from '~/components/instruments/MissionClock.vue'
import PlannerTelemetry from '~/components/instruments/PlannerTelemetry.vue'
import RevealMeter from '~/components/instruments/RevealMeter.vue'
import RoundCountdown from '~/components/instruments/RoundCountdown.vue'
import RoverAttitude from '~/components/instruments/RoverAttitude.vue'
import SlipGauge from '~/components/instruments/SlipGauge.vue'
import SpeedOdometer from '~/components/instruments/SpeedOdometer.vue'

type Instant = string | Date | number

/**
 * One instrument group over a snapshot of playback, as a panel or a sheet shows it: `clock` is
 * the mission clock with the round countdown when live, the others one instrument each. The
 * drive readings need a segment playing and at least one keyframe reached; `journey` needs the
 * live tally. Without what it needs, a group says so.
 */
withDefaults(
  defineProps<{
    group: InstrumentGroup
    drive?: {
      frame: Float32Array
      keyframes: KeyframeBlock
      events: DriveEvent[]
      reveals: RevealGroup[]
      /** Playback sim time, seconds. */
      t: number
      startedAt: Instant
      /** The segment's opening plan. */
      metrics: NavMetrics
      /** The plan's slope over seen ground, when the stop's ground is loaded. */
      profile?: SlopeProfile
      /** Ground distance of the journey before this segment, metres. */
      missionBeforeM: number
      /** Area the journey had revealed before this segment, square metres. */
      journeyBeforeM2: number
    } | null
    solsEpoch: Instant
    /** Wall-clock now on the server's clock, epoch milliseconds. */
    nowMs: number
    /** The live round, with the mission's rules; absent on a replay. */
    live?: {
      round: { closesAt: string | Date | null; submissions: RoundSubmission[] } | null
      driving: boolean
      rules: MissionRules
      tally: JourneyTally
    }
    cellSize?: number
    slopeLimitDeg?: number
  }>(),
  { drive: null, live: undefined, cellSize: 1, slopeLimitDeg: undefined },
)
</script>

<template>
  <div v-if="group === 'clock'" class="space-y-3">
    <MissionClock
      data-test="mission-clock"
      :sols-epoch="solsEpoch"
      :now-ms="nowMs"
      :segment-started-at="drive?.startedAt ?? null"
      :sim-time="drive?.t"
    />
    <RoundCountdown
      v-if="live"
      data-test="round-countdown"
      :round="live.round"
      :driving="live.driving"
      :now-ms="nowMs"
      :rules="live.rules"
    />
  </div>
  <RoverAttitude
    v-else-if="group === 'attitude' && drive"
    data-test="rover-attitude"
    :frame="drive.frame"
  />
  <SpeedOdometer
    v-else-if="group === 'speed' && drive"
    data-test="speed-odometer"
    :frame="drive.frame"
    :events="drive.events"
    :keyframes="drive.keyframes"
    :mission-before-m="drive.missionBeforeM"
  />
  <SlipGauge
    v-else-if="group === 'slip' && drive"
    data-test="slip-gauge"
    :keyframes="drive.keyframes"
    :t="drive.t"
  />
  <EventFeed
    v-else-if="group === 'events' && drive"
    data-test="event-feed"
    :events="drive.events"
    :t="drive.t"
  />
  <RevealMeter
    v-else-if="group === 'reveals' && drive"
    data-test="reveal-meter"
    :reveals="drive.reveals"
    :t="drive.t"
    :cell-size="cellSize"
    :journey-before-m2="drive.journeyBeforeM2"
  />
  <PlannerTelemetry
    v-else-if="group === 'planner' && drive"
    data-test="planner-telemetry"
    :metrics="drive.metrics"
    :profile="drive.profile"
    :slope-limit-deg="slopeLimitDeg"
  />
  <JourneyStats
    v-else-if="group === 'journey' && live"
    data-test="journey-stats"
    :tally="live.tally"
  />
  <p v-else data-test="instrument-idle" class="p-3 text-sm text-muted">No segment is playing.</p>
</template>
