<script setup lang="ts">
import { formatDuration } from '#shared/utils/client/instruments'
import type { DriveJson } from '~/composables/useJourney'

/** One settled drive, a segment of the mission, in a line: where from and to, how it ended, how far and long, and whose. */
const props = defineProps<{ drive: DriveJson }>()

const STATUS = {
  'arrived': { color: 'success', label: 'Arrived' },
  'stopped-short': { color: 'warning', label: 'Stopped short' },
  'failed': { color: 'error', label: 'Failed' },
} as const

const status = computed(() => STATUS[props.drive.status])
const route = computed(() => {
  const { from, to } = props.drive
  return `Stop ${from.index} → ${to ? `stop ${to.index}` : 'lost'}`
})
const started = computed(() =>
  new Date(props.drive.startedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }),
)
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
    <span class="w-14 tabular-nums text-muted" data-test="drive-number"
      >Segment {{ drive.number }}</span
    >
    <span class="font-medium" data-test="drive-route">{{ route }}</span>
    <UBadge :color="status.color" variant="subtle" size="sm" data-test="drive-status">
      {{ status.label }}
    </UBadge>
    <span class="tabular-nums" data-test="drive-distance">{{ Math.round(drive.distanceM) }} m</span>
    <span class="font-mono tabular-nums">{{ formatDuration(drive.durationS) }}</span>
    <span class="text-muted">{{ started }}</span>
    <span class="flex min-w-0 items-center gap-1 sm:ml-auto">
      <UAvatar
        :src="drive.submitter.avatarUrl ?? undefined"
        :alt="drive.submitter.displayName"
        size="2xs"
      />
      <span class="truncate" data-test="drive-submitter">{{ drive.submitter.displayName }}</span>
    </span>
  </div>
</template>
