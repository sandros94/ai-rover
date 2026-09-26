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
 * The instruments over one snapshot of playback. The drive readings need a segment playing and
 * at least one keyframe reached; the mission readings are always shown.
 */
withDefaults(
  defineProps<{
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
    round: { closesAt: string | Date | null; submissions: RoundSubmission[] } | null
    driving: boolean
    rules: MissionRules
    tally: JourneyTally
    cellSize?: number
    slopeLimitDeg?: number
  }>(),
  { drive: null, cellSize: 1, slopeLimitDeg: undefined },
)
</script>

<template>
  <section
    data-test="instruments"
    class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    aria-label="Instruments"
  >
    <MissionClock
      data-test="mission-clock"
      :sols-epoch="solsEpoch"
      :now-ms="nowMs"
      :segment-started-at="drive?.startedAt ?? null"
      :sim-time="drive?.t"
    />
    <RoundCountdown
      data-test="round-countdown"
      :round="round"
      :driving="driving"
      :now-ms="nowMs"
      :rules="rules"
    />
    <template v-if="drive">
      <RoverAttitude data-test="rover-attitude" class="sm:col-span-2" :frame="drive.frame" />
      <SpeedOdometer
        data-test="speed-odometer"
        :frame="drive.frame"
        :events="drive.events"
        :keyframes="drive.keyframes"
        :mission-before-m="drive.missionBeforeM"
      />
      <SlipGauge data-test="slip-gauge" :keyframes="drive.keyframes" :t="drive.t" />
      <EventFeed data-test="event-feed" :events="drive.events" :t="drive.t" />
      <RevealMeter
        data-test="reveal-meter"
        :reveals="drive.reveals"
        :t="drive.t"
        :cell-size="cellSize"
        :journey-before-m2="drive.journeyBeforeM2"
      />
      <PlannerTelemetry
        data-test="planner-telemetry"
        :metrics="drive.metrics"
        :profile="drive.profile"
        :slope-limit-deg="slopeLimitDeg"
      />
    </template>
    <JourneyStats data-test="journey-stats" :tally="tally" />
  </section>
</template>
