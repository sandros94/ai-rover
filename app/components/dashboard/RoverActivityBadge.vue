<script setup lang="ts">
import type { RoverActivity } from '#shared/utils/client'
import type { DriveEnding } from '#shared/utils/drive'

/** What the rover is doing now, in a word or two; narrow viewports get the shorter word. */
const props = defineProps<{ activity: RoverActivity }>()

type BadgeColor = 'primary' | 'info' | 'success' | 'warning' | 'error' | 'neutral'

/** Endings coloured as the settled drive they make: an arrival, a stop short, a failure. */
const ENDING: Record<DriveEnding, { icon: string; color: BadgeColor }> = {
  arrived: { icon: 'i-lucide-flag', color: DRIVE_STATUS.arrived.color },
  blocked: { icon: 'i-lucide-octagon-minus', color: DRIVE_STATUS['stopped-short'].color },
  hazard: { icon: 'i-lucide-triangle-alert', color: DRIVE_STATUS.failed.color },
  stuck: { icon: 'i-lucide-circle-slash', color: DRIVE_STATUS.failed.color },
}

const PHASE: Record<
  Exclude<RoverActivity['kind'], 'drive'>,
  { icon: string; color: BadgeColor }
> = {
  // The pause banner's colour.
  paused: { icon: 'i-lucide-circle-pause', color: 'warning' },
  planning: { icon: 'i-lucide-vote', color: 'info' },
  idle: { icon: 'i-lucide-hourglass', color: 'neutral' },
}

const look = computed(() => {
  const a = props.activity
  if (a.kind !== 'drive') return PHASE[a.kind]
  if (a.ending) return ENDING[a.ending]
  return { icon: DRIVE_STATUS_ICON[a.status], color: 'primary' as const }
})
</script>

<template>
  <UBadge
    data-test="rover-activity"
    :data-kind="activity.kind"
    :data-status="activity.kind === 'drive' ? activity.status : undefined"
    :color="look.color"
    :icon="look.icon"
    variant="subtle"
    class="shrink-0"
    role="status"
    aria-live="polite"
  >
    <span class="sr-only">Rover: </span>
    <span class="hidden sm:inline">{{ activity.label }}</span>
    <span class="sm:hidden">{{ activity.short }}</span>
  </UBadge>
</template>
