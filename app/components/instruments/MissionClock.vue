<script setup lang="ts">
import { formatDuration, formatLmst, solTime } from '#shared/utils/client/instruments'

type Instant = Date | string | number

const props = defineProps<{
  /** The mission's sol epoch: 00:00 LMST of sol 0. */
  solsEpoch: Instant
  /** Wall-clock now, epoch milliseconds (on the server's clock). */
  nowMs: number
  /** Wall-clock start of the playing segment; absent while none plays. */
  segmentStartedAt?: Instant | null
  /** Playback sim time into the segment, seconds. */
  simTime?: number
}>()

const ms = (at: Instant) => new Date(at).getTime()
const sol = computed(() => solTime(ms(props.solsEpoch), props.nowMs))
const wall = computed(() =>
  new Date(props.nowMs).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
)
/** Seconds playback trails wall-clock: the live view runs a slice plus a margin behind. */
const lag = computed(() =>
  props.segmentStartedAt == null
    ? null
    : (props.nowMs - ms(props.segmentStartedAt)) / 1000 - (props.simTime ?? 0),
)
/** Dial angle of the sol hand, degrees clockwise from midnight at the top. */
const hand = computed(() => sol.value.fraction * 360)
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4' }">
    <div class="flex items-center gap-4">
      <svg
        viewBox="-50 -50 100 100"
        class="size-24 shrink-0"
        role="img"
        :aria-label="`Sol ${sol.sol}, ${formatLmst(sol)} LMST`"
      >
        <circle r="44" fill="none" stroke="var(--viz-grid)" stroke-width="8" />
        <!-- Daylight arc, 06:00 to 18:00 LMST. -->
        <path
          d="M 44 0 A 44 44 0 0 1 -44 0"
          fill="none"
          stroke="var(--viz-track)"
          stroke-width="8"
        />
        <line
          v-for="h in 4"
          :key="h"
          y1="-36"
          y2="-30"
          class="stroke-(--ui-text-dimmed)"
          stroke-width="2"
          :transform="`rotate(${h * 90})`"
        />
        <g :transform="`rotate(${hand})`">
          <line
            y1="6"
            y2="-40"
            stroke="var(--viz-series-1)"
            stroke-width="3"
            stroke-linecap="round"
          />
        </g>
        <circle r="4" fill="var(--viz-series-1)" class="stroke-(--ui-bg)" stroke-width="2" />
      </svg>
      <div class="min-w-0">
        <p class="text-sm text-muted">
          Sol
          <span data-test="sol" class="text-highlighted text-2xl font-semibold">{{ sol.sol }}</span>
        </p>
        <p data-test="lmst" class="text-lg font-semibold tabular-nums">
          {{ formatLmst(sol) }} <span class="text-xs font-normal text-muted">LMST</span>
        </p>
      </div>
    </div>
    <dl class="mt-3 grid grid-cols-3 gap-2 text-sm">
      <div data-test="wall-clock">
        <dt class="text-xs text-muted">Earth</dt>
        <dd class="tabular-nums">{{ wall }}</dd>
      </div>
      <div data-test="drive-time">
        <dt class="text-xs text-muted">Driving</dt>
        <dd class="tabular-nums">{{ simTime === undefined ? '—' : formatDuration(simTime) }}</dd>
      </div>
      <div data-test="live-lag">
        <UTooltip text="How far playback trails the wall-clock">
          <dt class="text-xs text-muted">Behind live</dt>
        </UTooltip>
        <dd class="tabular-nums">{{ lag === null ? '—' : formatDuration(lag) }}</dd>
      </div>
    </dl>
  </UCard>
</template>
