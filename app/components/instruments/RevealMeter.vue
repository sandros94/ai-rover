<script setup lang="ts">
import type { RevealGroup } from '#shared/utils/client/instruments'
import { revealedAreaM2, revealRate } from '#shared/utils/client/instruments'

const props = withDefaults(
  defineProps<{
    /** The segment's reveal groups so far. */
    reveals: RevealGroup[]
    /** Playback sim time, seconds. */
    t: number
    /** Grid spacing, metres: one vertex stands for one cell. */
    cellSize?: number
    /** Area the journey had revealed before this segment, square metres. */
    journeyBeforeM2?: number
  }>(),
  { cellSize: 1, journeyBeforeM2: 0 },
)

const drive = computed(() => revealedAreaM2(props.reveals, props.t, props.cellSize))
const journey = computed(() => props.journeyBeforeM2 + drive.value)
/** The last 12 minutes of reveal rate, the current (partial) minute last. */
const rate = computed(() => revealRate(props.reveals, props.t, props.cellSize).slice(-12))

const W = 160
const H = 36
const spark = computed(() => {
  const values = rate.value
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? W / (values.length - 1) : 0
  const points = values.map((v, k) => [k * step, H - 4 - (v / max) * (H - 8)] as const)
  return {
    line: points.map((p) => p.join(',')).join(' '),
    end: points.at(-1)!,
    area: `0,${H} ${points.map((p) => p.join(',')).join(' ')} ${points.at(-1)![0]},${H}`,
  }
})
/** Side of the square whose area is the drive's reveal, relative to the journey's square. */
const share = computed(() => (journey.value > 0 ? Math.sqrt(drive.value / journey.value) : 0))
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4' }">
    <p class="mb-2 text-sm text-muted">Ground revealed</p>
    <div class="flex items-center gap-4">
      <svg
        viewBox="0 0 64 64"
        class="size-16 shrink-0"
        role="img"
        :aria-label="`${fmt.format(drive)} of ${fmt.format(journey)} square metres revealed this drive`"
      >
        <rect x="1" y="1" width="62" height="62" rx="4" fill="var(--viz-track)" />
        <rect
          x="1"
          :y="63 - 62 * share"
          :width="62 * share"
          :height="62 * share"
          rx="4"
          fill="var(--viz-series-1)"
          class="transition-all duration-300"
        />
      </svg>
      <dl class="grid flex-1 grid-cols-2 gap-2">
        <div data-test="reveal-drive">
          <dt class="text-xs text-muted">This drive</dt>
          <dd class="text-xl font-semibold">
            <span class="readout min-w-[8ch]">{{ fmt.format(drive) }}</span>
            <span class="text-xs font-normal text-muted">m²</span>
          </dd>
        </div>
        <div data-test="reveal-journey">
          <dt class="text-xs text-muted">Journey</dt>
          <dd class="text-xl font-semibold">
            <span class="readout min-w-[8ch]">{{ fmt.format(journey) }}</span>
            <span class="text-xs font-normal text-muted">m²</span>
          </dd>
        </div>
      </dl>
    </div>
    <div class="mt-3">
      <p class="text-xs text-muted">
        Per minute · now
        <span class="readout min-w-[4ch]">{{ compact.format(rate.at(-1) ?? 0) }}</span> m²
      </p>
      <div class="relative h-10">
        <svg
          data-test="sparkline"
          :viewBox="`0 0 ${W} ${H}`"
          preserveAspectRatio="none"
          class="absolute inset-0 size-full overflow-visible"
          role="img"
          aria-label="Square metres revealed per minute"
        >
          <polygon :points="spark.area" fill="var(--viz-series-1)" fill-opacity="0.1" />
          <polyline
            :points="spark.line"
            fill="none"
            stroke="var(--viz-series-1)"
            stroke-width="2"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <span
          class="absolute size-2.5 -translate-1/2 rounded-full bg-(--viz-series-1) ring-2 ring-(--ui-bg)"
          :style="{ left: `${(spark.end[0] / W) * 100}%`, top: `${(spark.end[1] / H) * 100}%` }"
        />
      </div>
    </div>
  </UCard>
</template>
