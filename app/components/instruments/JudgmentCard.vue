<script setup lang="ts">
import type { MissionStateJson } from '~/composables/useMissionState'

type Public = NonNullable<MissionStateJson['round']>['submissions'][number]['judgment']
/** Without per-level probabilities the levels are drawn from the expected values alone. */
type Judgment = Omit<Public, 'probabilities'> & { probabilities?: Public['probabilities'] }

const props = defineProps<{ judgment: Judgment }>()

const VERDICT = {
  accept: { color: 'success', icon: 'i-lucide-circle-check', label: 'Accept' },
  review: { color: 'warning', icon: 'i-lucide-circle-help', label: 'Review' },
  reject: { color: 'error', icon: 'i-lucide-circle-x', label: 'Reject' },
} as const
/** Jev's risk levels, safest first, in the status colours they stand for. */
const RISK = [
  { label: 'Clear', fill: 'var(--viz-good)' },
  { label: 'Minor', fill: 'var(--viz-warning)' },
  { label: 'Real', fill: 'var(--viz-serious)' },
  { label: 'Likely', fill: 'var(--viz-critical)' },
]
/** Both confidences are Score answers over five levels; the weight is the expected level over 4. */
const CONFIDENCE_LEVELS = 5

const GAP = 2
/** Marker position, percent: level k spans [k, k + 1) quarters, its centre at k + ½. */
const riskPct = computed(() => ((props.judgment.risk + 0.5) / RISK.length) * 100)
/** A level's opacity: its probability when known, else whether the expected value falls in it. */
const riskOpacity = (k: number) => {
  const p = props.judgment.probabilities?.risk[k]
  return p === undefined ? (Math.abs(props.judgment.risk - k) < 0.5 ? 1 : 0.35) : 0.2 + 0.8 * p
}
const percent = (p: number) => `${Math.round(p * 100)} %`
const confidences = computed(() =>
  [
    {
      id: 'distance-confidence',
      label: 'Distance confidence',
      weight: props.judgment.distanceWeight,
      probabilities: props.judgment.probabilities?.distanceConfidence,
    },
    {
      id: 'time-confidence',
      label: 'Time confidence',
      weight: props.judgment.timeWeight,
      probabilities: props.judgment.probabilities?.timeConfidence,
    },
  ].map((c) => {
    const level = c.weight * (CONFIDENCE_LEVELS - 1)
    const probabilities =
      c.probabilities?.length === CONFIDENCE_LEVELS ? c.probabilities : undefined
    return {
      ...c,
      level,
      probabilities,
      markerPct: ((level + 0.5) / CONFIDENCE_LEVELS) * 100,
      // With probabilities every block is whole and weighted by opacity; without, a meter.
      blocks: Array.from({ length: CONFIDENCE_LEVELS }, (_, k) =>
        probabilities ? 1 : Math.max(0, Math.min(1, level + 1 - k)),
      ),
      opacity: (k: number) => (probabilities ? 0.2 + 0.8 * probabilities[k]! : 1),
    }
  }),
)
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4 space-y-3' }">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm text-muted">Jev's judgment</p>
      <UBadge
        data-test="verdict"
        :color="VERDICT[judgment.verdict].color"
        :icon="VERDICT[judgment.verdict].icon"
        variant="subtle"
        :label="VERDICT[judgment.verdict].label"
      />
    </div>
    <div data-test="feasible">
      <div class="flex items-baseline justify-between text-sm">
        <span class="text-muted">Feasible</span>
        <span class="font-semibold tabular-nums">{{ Math.round(judgment.feasible * 100) }} %</span>
      </div>
      <UProgress
        :model-value="judgment.feasible * 100"
        size="md"
        :ui="{ indicator: 'bg-(--viz-series-1)', base: 'bg-(--viz-track)' }"
      />
    </div>
    <div>
      <div class="flex items-baseline justify-between text-sm">
        <span class="text-muted">Risk</span>
        <span class="font-semibold tabular-nums"
          >{{ judgment.risk.toFixed(1) }} / {{ RISK.length - 1 }}</span
        >
      </div>
      <svg
        class="block h-5 w-full overflow-visible"
        role="img"
        :aria-label="`Expected risk level ${judgment.risk.toFixed(1)} of ${RISK.length - 1}`"
      >
        <rect
          v-for="(level, k) in RISK"
          :key="k"
          data-test="risk-level"
          :x="`${(k * 100) / RISK.length}%`"
          y="9"
          :style="{ width: `calc(${100 / RISK.length}% - ${GAP}px)` }"
          height="10"
          rx="4"
          :fill="level.fill"
          :opacity="riskOpacity(k)"
        />
        <svg :x="`${riskPct}%`" overflow="visible">
          <path
            d="M 0 8 l -5 -7 h 10 z"
            class="fill-(--ui-text-highlighted) stroke-(--ui-bg)"
            stroke-width="2"
          />
        </svg>
      </svg>
      <div class="grid grid-cols-4 text-center text-xs text-muted">
        <span v-for="level in RISK" :key="level.label">{{ level.label }}</span>
      </div>
      <div
        v-if="judgment.probabilities?.risk.length === RISK.length"
        class="grid grid-cols-4 text-center text-xs tabular-nums"
      >
        <span v-for="(p, k) in judgment.probabilities.risk" :key="k" data-test="risk-probability">{{
          percent(p)
        }}</span>
      </div>
    </div>
    <div v-for="c in confidences" :key="c.id" :data-test="c.id">
      <div class="flex items-baseline justify-between text-sm">
        <span class="text-muted">{{ c.label }}</span>
        <span class="font-semibold tabular-nums"
          >{{ (c.level + 1).toFixed(1) }} / {{ CONFIDENCE_LEVELS }}</span
        >
      </div>
      <svg
        class="block w-full overflow-visible"
        :class="c.probabilities ? 'h-5' : 'h-2.5'"
        role="img"
        :aria-label="`${c.label} ${(c.level + 1).toFixed(1)} of ${CONFIDENCE_LEVELS}`"
      >
        <g v-for="(fill, k) in c.blocks" :key="k" data-test="level">
          <rect
            :x="`${(k * 100) / CONFIDENCE_LEVELS}%`"
            :y="c.probabilities ? 9 : 0"
            :style="{ width: `calc(${100 / CONFIDENCE_LEVELS}% - ${GAP}px)` }"
            height="10"
            rx="3"
            fill="var(--viz-track)"
          />
          <rect
            :x="`${(k * 100) / CONFIDENCE_LEVELS}%`"
            :y="c.probabilities ? 9 : 0"
            :style="{ width: `calc((${100 / CONFIDENCE_LEVELS}% - ${GAP}px) * ${fill})` }"
            height="10"
            rx="3"
            fill="var(--viz-series-1)"
            :opacity="c.opacity(k)"
          />
        </g>
        <svg v-if="c.probabilities" :x="`${c.markerPct}%`" overflow="visible">
          <path
            d="M 0 8 l -5 -7 h 10 z"
            class="fill-(--ui-text-highlighted) stroke-(--ui-bg)"
            stroke-width="2"
          />
        </svg>
      </svg>
      <div v-if="c.probabilities" class="grid grid-cols-5 text-center text-xs tabular-nums">
        <span v-for="(p, k) in c.probabilities" :key="k" data-test="level-probability">{{
          percent(p)
        }}</span>
      </div>
    </div>
  </UCard>
</template>
