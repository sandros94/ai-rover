<script setup lang="ts">
import { createOdometer, driveEfficiency } from '#shared/utils/client/instruments'
import type { DriveEvent, KeyframeBlock } from '#shared/utils/drive'
import { DEFAULT_SPEED_MODEL, KEYFRAME_FIELDS } from '#shared/utils/drive'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values at the playback time. */
    frame: Float32Array
    /** Events up to the playback time. */
    events: DriveEvent[]
    /** The segment's keyframes so far, for the odometers. */
    keyframes: KeyframeBlock
    /** Ground distance of the journey before this segment, metres. */
    missionBeforeM?: number
    maxSpeedMps?: number
  }>(),
  { missionBeforeM: 0, maxSpeedMps: DEFAULT_SPEED_MODEL.maxSpeedMps },
)

const t = computed(() => props.frame[KEYFRAME_FIELDS.indexOf('t')]!)
const speed = computed(() => props.frame[KEYFRAME_FIELDS.indexOf('speed')]!)
const odometer = computed(() => createOdometer(props.keyframes))
const reading = computed(() => odometer.value.at(t.value))
const efficiency = computed(() =>
  driveEfficiency({
    actualM: reading.value.actualM,
    elapsedS: t.value,
    maxSpeedMps: props.maxSpeedMps,
  }),
)
/** Stopped inside a pause's window: the rover looks and decides before the next metre. */
const pausing = computed(() => {
  if (speed.value > 0) return false
  const pause = props.events.findLast((e) => e.type === 'pause')
  const duration = typeof pause?.details?.durationS === 'number' ? pause.details.durationS : 0
  return pause !== undefined && t.value < pause.t + duration
})

/** Bars in cm/s, the scale ending a fifth past the cap. */
const scale = computed(() => props.maxSpeedMps * 100 * 1.2)
const bars = computed(() => [
  { id: 'speed-actual', label: 'Actual', cms: speed.value * 100, fill: 'var(--viz-series-1)' },
  {
    id: 'speed-commanded',
    label: 'Commanded',
    cms: props.maxSpeedMps * 100,
    fill: 'var(--viz-track)',
  },
])
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4 space-y-3' }">
    <div class="flex items-baseline justify-between gap-2">
      <p class="text-sm text-muted">Speed</p>
      <UBadge
        v-if="pausing"
        data-test="think-pause"
        icon="i-lucide-hourglass"
        color="neutral"
        variant="subtle"
        size="sm"
        label="Thinking"
      />
    </div>
    <p class="text-3xl font-semibold">
      {{ (speed * 100).toFixed(1) }} <span class="text-base font-normal text-muted">cm/s</span>
    </p>
    <div
      class="space-y-2"
      role="img"
      :aria-label="`Actual ${(speed * 100).toFixed(1)} of ${(maxSpeedMps * 100).toFixed(1)} cm/s commanded`"
    >
      <div v-for="bar in bars" :key="bar.id" :data-test="bar.id">
        <div class="flex justify-between text-xs">
          <span class="text-muted">{{ bar.label }}</span>
          <span class="tabular-nums">{{ bar.cms.toFixed(1) }}</span>
        </div>
        <svg class="block h-2.5 w-full" aria-hidden="true">
          <rect width="100%" height="10" rx="4" fill="var(--viz-grid)" />
          <rect
            :width="`${Math.min(100, (bar.cms / scale) * 100)}%`"
            height="10"
            rx="4"
            :fill="bar.fill"
          />
        </svg>
      </div>
    </div>
    <dl class="grid grid-cols-3 gap-2">
      <div data-test="odometer-segment">
        <dt class="text-xs text-muted">Segment</dt>
        <dd class="font-semibold">{{ reading.actualM.toFixed(2) }} m</dd>
      </div>
      <div data-test="odometer-mission">
        <dt class="text-xs text-muted">Mission</dt>
        <dd class="font-semibold">{{ fmt.format(missionBeforeM + reading.actualM) }} m</dd>
      </div>
      <div data-test="efficiency">
        <UTooltip text="Effective speed so far over the commanded speed">
          <dt class="text-xs text-muted">Efficiency</dt>
        </UTooltip>
        <dd class="font-semibold">
          {{ efficiency === undefined ? '—' : `${Math.round(efficiency * 100)} %` }}
        </dd>
      </div>
    </dl>
  </UCard>
</template>
