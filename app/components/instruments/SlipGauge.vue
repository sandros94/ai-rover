<script setup lang="ts">
import { createOdometer, slipOverLastMetre } from '#shared/utils/client/instruments'
import type { KeyframeBlock } from '#shared/utils/drive'
import { DEFAULT_SLIP_MODEL } from '#shared/utils/drive'

const props = withDefaults(
  defineProps<{
    keyframes: KeyframeBlock
    /** Playback sim time, seconds. */
    t: number
    /** Slip at or above this counts toward getting stuck. */
    stuckAbove?: number
  }>(),
  { stuckAbove: DEFAULT_SLIP_MODEL.stuckAbove },
)

const odometer = computed(() => createOdometer(props.keyframes))
const last = computed(() => slipOverLastMetre(odometer.value, props.t))
const level = computed(() =>
  last.value.slip >= props.stuckAbove
    ? 'fail'
    : last.value.slip > DEFAULT_SLIP_MODEL.eventAbove
      ? 'warn'
      : 'ok',
)
const FILL = { ok: 'var(--viz-series-1)', warn: 'var(--viz-warning)', fail: 'var(--viz-critical)' }

/** The commanded metre as 20 tread blocks, filled as far as the ground actually covered. */
const BLOCKS = Array.from({ length: 20 }, (_, k) => k)
const STEP = 100 / BLOCKS.length
/** Percent of the commanded distance covered on the ground. */
const covered = computed(() => (1 - last.value.slip) * 100)
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4 space-y-2' }">
    <div class="flex items-baseline justify-between gap-2">
      <p class="text-sm text-muted">Slip, last metre</p>
      <UBadge
        v-if="level !== 'ok'"
        :color="level === 'fail' ? 'error' : 'warning'"
        variant="subtle"
        size="sm"
        :icon="level === 'fail' ? 'i-lucide-circle-slash' : 'i-lucide-waves'"
        :label="level === 'fail' ? 'Stuck risk' : 'Slipping'"
      />
    </div>
    <p class="text-3xl font-semibold">
      <span data-test="slip-value">{{ Math.round(last.slip * 100) }}</span>
      <span class="text-base font-normal text-muted">%</span>
    </p>
    <p class="text-xs text-muted">Wheels turned {{ last.commandedM.toFixed(2) }} m</p>
    <svg
      data-test="slip-track"
      :data-level="level"
      class="block h-6 w-full"
      role="img"
      :aria-label="`Commanded ${last.commandedM.toFixed(2)} m, actual ${last.actualM.toFixed(2)} m`"
    >
      <rect
        v-for="k in BLOCKS"
        :key="k"
        :x="`${k * STEP}%`"
        y="4"
        :width="`${STEP * 0.8}%`"
        height="14"
        rx="2"
        fill="var(--viz-grid)"
      />
      <rect
        v-for="k in BLOCKS.filter((b) => b * STEP < covered)"
        :key="`a${k}`"
        :x="`${k * STEP}%`"
        y="4"
        :width="`${Math.min(STEP * 0.8, covered - k * STEP)}%`"
        height="14"
        rx="2"
        :fill="FILL[level]"
      />
      <line
        :x1="`${(1 - stuckAbove) * 100}%`"
        :x2="`${(1 - stuckAbove) * 100}%`"
        y1="0"
        y2="22"
        stroke="var(--viz-critical)"
        stroke-width="2"
      />
    </svg>
    <div class="flex justify-between gap-2 text-xs text-muted">
      <span>Ground covered {{ last.actualM.toFixed(2) }} m</span>
      <span>stuck below {{ Math.round((1 - stuckAbove) * 100) }} % covered</span>
    </div>
  </UCard>
</template>
