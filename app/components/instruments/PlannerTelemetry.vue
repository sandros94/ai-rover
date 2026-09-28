<script setup lang="ts">
import type { SlopeProfile } from '#shared/utils/client/instruments'
import type { PublishedPlanMetrics } from '#shared/utils/drive'

const props = defineProps<{
  /** A plan's metrics, as published with its segment. */
  metrics: PublishedPlanMetrics
  /** The planned route's slope by distance; the profile is left out without it. */
  profile?: SlopeProfile
  /** The world's steepest traversable slope, degrees. */
  slopeLimitDeg?: number
}>()

const stats = computed(() => {
  const m = props.metrics
  const route = m.reached
  return [
    { label: 'Path', value: route ? `${m.pathLengthM.toFixed(0)} m` : '—' },
    { label: 'Straight line', value: `${m.straightLineM.toFixed(0)} m` },
    { label: 'Detour', value: route ? `${m.detourRatio.toFixed(2)}×` : '—' },
    {
      label: 'Max slope',
      value: route ? `${m.maxSlopeDeg.toFixed(1)}°` : '—',
      hint: 'Over seen ground only',
    },
    {
      label: 'Mean slope',
      value: route ? `${m.meanSlopeDeg.toFixed(1)}°` : '—',
      hint: 'Over seen ground only',
    },
    { label: 'Unseen', value: route ? `${Math.round(m.unrevealedFraction * 100)} %` : '—' },
    { label: 'Turns', value: route ? String(m.turnCount) : '—' },
    { label: 'Expansions', value: new Intl.NumberFormat('en').format(m.expansions) },
    { label: 'Compute', value: `${m.computeMs.toFixed(0)} ms` },
  ]
})

const W = 300
const H = 64
/**
 * The profile as runs of consecutive samples of one kind, each run starting where the previous
 * ended; unseen samples sit on the baseline, their slope unknown.
 */
const chart = computed(() => {
  const p = props.profile
  if (!p || p.samples.length < 2) return null
  const top = Math.max(props.slopeLimitDeg ?? 0, ...p.samples.map((s) => s.slopeDeg ?? 0), 1)
  const x = (d: number) => (p.lengthM > 0 ? (d / p.lengthM) * W : 0).toFixed(1)
  const y = (deg: number | null) => H - ((deg ?? 0) / top) * (H - 6)
  const runs: { seen: boolean; points: string[] }[] = []
  for (const s of p.samples) {
    const seen = s.slopeDeg !== null
    const point = `${x(s.distanceM)},${y(s.slopeDeg).toFixed(1)}`
    const last = runs.at(-1)
    if (last?.seen === seen) last.points.push(point)
    else runs.push({ seen, points: last ? [last.points.at(-1)!, point] : [point] })
  }
  return {
    runs: runs.map((run) => ({ seen: run.seen, points: run.points.join(' ') })),
    limitY: props.slopeLimitDeg ? y(props.slopeLimitDeg) : null,
  }
})
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4' }">
    <div class="mb-2 flex items-baseline justify-between gap-2">
      <p class="text-sm text-muted">Planner</p>
      <UBadge
        v-if="!metrics.reached"
        color="error"
        variant="subtle"
        size="sm"
        icon="i-lucide-octagon-x"
        :label="metrics.failureReason ?? 'no route'"
      />
    </div>
    <dl class="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-5">
      <div v-for="s in stats" :key="s.label" data-test="metric">
        <dt class="text-xs text-muted" :title="s.hint">{{ s.label }}</dt>
        <dd class="font-semibold tabular-nums">{{ s.value }}</dd>
      </div>
    </dl>
    <figure v-if="chart" class="mt-3">
      <div class="relative h-16">
        <svg
          :viewBox="`0 0 ${W} ${H}`"
          preserveAspectRatio="none"
          class="absolute inset-0 size-full overflow-visible"
          role="img"
          aria-label="Slope along the planned route"
        >
          <line
            x1="0"
            :x2="W"
            :y1="H"
            :y2="H"
            stroke="var(--viz-axis)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <line
            v-if="chart.limitY !== null"
            x1="0"
            :x2="W"
            :y1="chart.limitY"
            :y2="chart.limitY"
            stroke="var(--viz-serious)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <polyline
            v-for="(run, k) in chart.runs"
            :key="k"
            :data-test="run.seen ? 'profile-seen' : 'profile-unseen'"
            :points="run.points"
            fill="none"
            :stroke="run.seen ? 'var(--viz-series-1)' : 'var(--viz-axis)'"
            :stroke-width="run.seen ? 2 : 3"
            :stroke-dasharray="run.seen ? undefined : '2 5'"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <span
          v-if="chart.limitY !== null"
          class="absolute right-0 -translate-y-full text-[10px] text-dimmed"
          :style="{ top: `${(chart.limitY / H) * 100}%` }"
        >
          limit {{ slopeLimitDeg }}°
        </span>
      </div>
      <figcaption class="flex justify-between text-xs text-muted">
        <span>Slope by distance · unseen ground dotted, its slope unknown</span>
        <span>{{ profile?.lengthM.toFixed(0) }} m</span>
      </figcaption>
    </figure>
  </UCard>
</template>
