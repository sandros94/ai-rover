<script setup lang="ts">
import { feedItems, formatDuration } from '#shared/utils/client/instruments'
import type { DriveEvent, DriveEventType } from '#shared/utils/drive'

const props = withDefaults(
  defineProps<{
    /** Events up to the playback time. */
    events: DriveEvent[]
    /** Playback sim time, seconds. */
    t: number
    /** Items shown; older ones are dropped. */
    limit?: number
  }>(),
  { limit: 8 },
)

/** Icon and label per event; status colours only where the event is a state of the drive. */
const KIND: Record<DriveEventType, { icon: string; label: string; color?: string }> = {
  start: { icon: 'i-lucide-play', label: 'Started' },
  steering: { icon: 'i-lucide-arrow-left-right', label: 'Steering wheels' },
  turning: { icon: 'i-lucide-rotate-cw', label: 'Turning' },
  assessing: { icon: 'i-lucide-scan-search', label: 'Assessing' },
  replan: { icon: 'i-lucide-route', label: 'Replanned' },
  imaging: { icon: 'i-lucide-camera', label: 'Imaging stop' },
  slip: { icon: 'i-lucide-waves', label: 'Slipping', color: 'var(--viz-warning)' },
  blocked: { icon: 'i-lucide-octagon-minus', label: 'Stopped short', color: 'var(--viz-serious)' },
  hazard: { icon: 'i-lucide-triangle-alert', label: 'Hazard', color: 'var(--viz-critical)' },
  stuck: { icon: 'i-lucide-circle-slash', label: 'Stuck', color: 'var(--viz-critical)' },
  arrived: { icon: 'i-lucide-flag', label: 'Arrived', color: 'var(--viz-good)' },
}

const items = computed(() => feedItems(props.events, props.t).slice(0, props.limit))

function detail(item: (typeof items.value)[number]): string | undefined {
  const d = item.details
  const seconds = typeof d?.durationS === 'number' ? `${Math.round(d.durationS)} s` : undefined
  if (item.type === 'turning' && typeof d?.angleDeg === 'number')
    return `${Math.round(Math.abs(d.angleDeg))}° ${d.angleDeg > 0 ? 'left' : 'right'}`
  if (item.type === 'imaging' || item.type === 'steering') return seconds
  if (item.type === 'assessing')
    return [seconds, typeof d?.cause === 'string' && `${d.cause} ground`].filter(Boolean).join(', ')
  if (item.type === 'slip' && typeof d?.slip === 'number')
    return `${Math.round(d.slip * 100)} % slip`
  if (item.type === 'replan' && typeof d?.cause === 'string') return `${d.cause} ground`
  if (Array.isArray(d?.reasons) && typeof d.reasons[0] === 'string')
    return (d.reasons as string[]).join(', ')
  return undefined
}
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4' }">
    <p class="mb-2 text-sm text-muted">Drive log</p>
    <p v-if="!items.length" class="text-sm text-dimmed">No events yet.</p>
    <ol class="relative space-y-2 border-l border-default pl-4">
      <li v-for="item in items" :key="item.key" data-test="event" class="relative">
        <span
          data-test="event-icon"
          :data-icon="KIND[item.type].icon"
          class="absolute top-0.5 -left-[1.6rem] flex size-5 items-center justify-center rounded-full bg-(--ui-bg) ring-2 ring-(--ui-bg)"
        >
          <UIcon
            :name="KIND[item.type].icon"
            class="size-4"
            :style="{ color: KIND[item.type].color ?? 'var(--ui-text-muted)' }"
          />
        </span>
        <div class="flex items-baseline justify-between gap-2 text-sm">
          <span class="font-medium">{{ KIND[item.type].label }}</span>
          <span class="shrink-0 text-xs text-dimmed tabular-nums"
            >{{ formatDuration(item.ageS) }} ago</span
          >
        </div>
        <p v-if="detail(item)" class="text-xs text-muted">{{ detail(item) }}</p>
      </li>
    </ol>
  </UCard>
</template>
