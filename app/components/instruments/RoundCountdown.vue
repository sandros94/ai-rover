<script setup lang="ts">
import type { RoundSubmission } from '#shared/utils/client/instruments'
import { formatDuration, roundPhase } from '#shared/utils/client/instruments'
import type { MissionRules } from '#shared/utils/mission'

const props = defineProps<{
  /** The public open round's close time and submissions; null when none is open. */
  round: { closesAt: string | Date | null; submissions: RoundSubmission[] } | null
  /** A segment is playing. */
  driving: boolean
  /** Wall-clock now, epoch milliseconds (on the server's clock). */
  nowMs: number
  rules: MissionRules
}>()

const phase = computed(() => roundPhase(props))
const STATE = {
  idle: {
    title: 'Rover idle',
    note: 'The vote closes once the first destination waits out its planning phase.',
  },
  open: { title: 'Voting open', note: 'The vote closes when the current drive ends.' },
  planning: {
    title: 'Planning phase',
    note: 'The destination with the most LGTMs drives next.',
  },
} as const

const R = 42
const C = 2 * Math.PI * R
/** Ring share still to run: the planning phase's remainder; full while open, empty while idle. */
const fill = computed(() => {
  const p = phase.value
  return p.kind === 'planning' ? p.fraction : p.kind === 'open' ? 1 : 0
})
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4' }">
    <div class="flex items-center gap-4">
      <svg
        data-test="ring"
        viewBox="-50 -50 100 100"
        class="size-28 shrink-0"
        role="img"
        :aria-label="STATE[phase.kind].title"
      >
        <circle :r="R" fill="none" stroke="var(--viz-track)" stroke-width="8" />
        <circle
          :r="R"
          fill="none"
          stroke="var(--viz-series-1)"
          stroke-width="8"
          stroke-linecap="round"
          :stroke-dasharray="`${C * fill} ${C}`"
          :stroke-opacity="phase.kind === 'open' ? 0.35 : 1"
          transform="rotate(-90)"
          class="transition-[stroke-dasharray] duration-500"
        />
        <text
          v-if="phase.kind === 'planning'"
          data-test="remaining"
          y="6"
          text-anchor="middle"
          class="fill-(--ui-text-highlighted) text-[18px] font-semibold tabular-nums"
        >
          {{ formatDuration(Math.ceil(phase.remainingMs / 1000)) }}
        </text>
        <foreignObject v-else x="-12" y="-12" width="24" height="24">
          <UIcon
            :name="phase.kind === 'open' ? 'i-lucide-vote' : 'i-lucide-moon'"
            class="size-6 text-muted"
          />
        </foreignObject>
      </svg>
      <div class="min-w-0 space-y-1">
        <p class="font-semibold">{{ STATE[phase.kind].title }}</p>
        <p class="text-xs text-muted">{{ STATE[phase.kind].note }}</p>
        <p v-if="phase.leader" class="flex items-center gap-1 text-sm">
          <UIcon name="i-lucide-thumbs-up" class="size-4 text-muted" />
          <span data-test="leader-likes" class="font-semibold tabular-nums">{{
            phase.leader.likes
          }}</span>
          <span class="text-muted">LGTM on the leading pick</span>
        </p>
        <p v-else class="text-sm text-dimmed">No submissions yet.</p>
      </div>
    </div>
  </UCard>
</template>
