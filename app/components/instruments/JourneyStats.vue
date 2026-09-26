<script lang="ts">
/** Journey totals so far. */
export interface JourneyTally {
  /** Ground distance driven over every segment, metres. */
  distanceM: number
  /** Stops reached, the landing stop included. */
  stops: number
  arrived: number
  stoppedShort: number
  failed: number
  /** Returns to the previous stop after repeated failures. */
  resets: number
  /** Ground distance of the longest segment, metres. */
  longestM: number
}
</script>

<script setup lang="ts">
const props = defineProps<{ tally: JourneyTally }>()

const whole = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
const segments = computed(() => props.tally.arrived + props.tally.stoppedShort + props.tally.failed)
/** Outcome shares, in the status colours they stand for; icons carry them too. */
const outcomes = computed(() =>
  [
    {
      label: 'Arrived',
      value: props.tally.arrived,
      fill: 'var(--viz-good)',
      icon: 'i-lucide-flag',
    },
    {
      label: 'Stopped short',
      value: props.tally.stoppedShort,
      fill: 'var(--viz-warning)',
      icon: 'i-lucide-octagon-minus',
    },
    {
      label: 'Failed',
      value: props.tally.failed,
      fill: 'var(--viz-critical)',
      icon: 'i-lucide-octagon-x',
    },
  ].map((o) => ({ ...o, share: segments.value ? o.value / segments.value : 0 })),
)
const stats = computed(() => [
  { label: 'Distance', value: `${whole.format(props.tally.distanceM)} m` },
  { label: 'Stops', value: whole.format(props.tally.stops) },
  ...outcomes.value.map((o) => ({
    label: o.label,
    value: whole.format(o.value),
    icon: o.icon,
    fill: o.fill,
  })),
  { label: 'Resets', value: whole.format(props.tally.resets) },
  { label: 'Longest segment', value: `${whole.format(props.tally.longestM)} m` },
])
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4 space-y-3' }">
    <p class="text-sm text-muted">Journey</p>
    <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div
        v-for="s in stats"
        :key="s.label"
        data-test="stat"
        class="rounded-md border border-default px-2 py-1.5"
      >
        <dt class="flex items-center gap-1 text-xs text-muted">
          <UIcon v-if="'icon' in s" :name="s.icon!" class="size-3.5" :style="{ color: s.fill }" />
          {{ s.label }}
        </dt>
        <dd class="text-lg font-semibold">{{ s.value }}</dd>
      </div>
    </dl>
    <svg
      v-if="segments"
      viewBox="0 0 300 10"
      class="w-full"
      role="img"
      :aria-label="outcomes.map((o) => `${o.label} ${o.value}`).join(', ')"
    >
      <template v-for="(o, k) in outcomes" :key="o.label">
        <rect
          v-if="o.share > 0"
          :x="outcomes.slice(0, k).reduce((sum, p) => sum + p.share, 0) * 300"
          y="0"
          :width="Math.max(0, o.share * 300 - 2)"
          height="10"
          rx="3"
          :fill="o.fill"
        />
      </template>
    </svg>
  </UCard>
</template>
