<script setup lang="ts">
import { createOdometer, driveEfficiency } from '#shared/utils/client/instruments'
import type { DriveEvent, DriveStatus, KeyframeBlock } from '#shared/utils/drive'
import { KEYFRAME_FIELDS, statusAt } from '#shared/utils/drive'
import { ROVER_MAX_SPEED_MPS } from '#shared/utils/rover'

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
    /** The commanded cap the bars and efficiency measure against. */
    maxSpeedMps?: number
  }>(),
  { missionBeforeM: 0, maxSpeedMps: ROVER_MAX_SPEED_MPS },
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
const STATUS_ICON: Record<DriveStatus, string> = {
  driving: 'i-lucide-navigation',
  turning: 'i-lucide-rotate-cw',
  assessing: 'i-lucide-scan-search',
  imaging: 'i-lucide-camera',
  stopped: 'i-lucide-circle-pause',
}
/** What the rover is doing at the playback time, so a stop never reads as a fault. */
const status = computed(() => {
  const run = statusAt(props.events, t.value)
  let label: string = run.status
  if (run.status === 'turning' && run.angleDeg !== undefined)
    label = `turning ${Math.round(Math.abs(run.angleDeg))}°`
  if (run.status === 'imaging' && run.endsAt !== undefined)
    label = `imaging stop ${Math.max(0, Math.ceil(run.endsAt - t.value))} s`
  return { status: run.status, label, icon: STATUS_ICON[run.status] }
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
        data-test="drive-status"
        :data-status="status.status"
        :icon="status.icon"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="status.label"
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
        <UTooltip
          :text="`Effective speed so far, stops included, over the ${(maxSpeedMps * 100).toFixed(1)} cm/s commanded cap`"
        >
          <dt class="text-xs text-muted">
            Efficiency <span class="block text-[10px] leading-tight">vs commanded cap</span>
          </dt>
        </UTooltip>
        <dd class="font-semibold">
          {{ efficiency === undefined ? '—' : `${Math.round(efficiency * 100)} %` }}
        </dd>
      </div>
    </dl>
  </UCard>
</template>
