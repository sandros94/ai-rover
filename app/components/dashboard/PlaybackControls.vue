<script setup lang="ts">
import type { PlaybackMode, PlaybackRate } from '#shared/utils/client'
import { PLAYBACK_RATES } from '#shared/utils/client'
import { formatDuration } from '#shared/utils/client/instruments'

const props = withDefaults(
  defineProps<{
    /** Playback sim time, seconds. */
    simTime: number
    /** The end of the released range, sim seconds: nothing past it can be shown yet. */
    releasedUntil: number
    mode: PlaybackMode
    /** Replay speed; live always runs at 1×, so it applies once playback is scrubbed back. */
    rate: PlaybackRate
    /** Seconds playback trails wall-clock; absent when there is nothing to trail. */
    lagS?: number | null
  }>(),
  { lagS: null },
)

const emit = defineEmits<{ seek: [simSeconds: number]; rate: [rate: PlaybackRate]; live: [] }>()

const max = computed(() => Math.max(1, Math.round(props.releasedUntil)))
const position = computed(() => Math.min(max.value, Math.max(0, props.simTime)))

function onScrub(value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) emit('seek', value)
}
</script>

<template>
  <div class="space-y-2 rounded-lg border border-default p-2" data-test="playback">
    <USlider
      :model-value="position"
      :min="0"
      :max="max"
      :step="1"
      size="sm"
      aria-label="Playback position"
      @update:model-value="onScrub"
    />
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="font-mono tabular-nums" data-test="sim-time">{{
        formatDuration(position)
      }}</span>
      <span class="text-muted">/ {{ formatDuration(max) }}</span>
      <span v-if="lagS !== null" class="text-muted" data-test="lag">
        {{ Math.max(0, Math.round(lagS)) }} s behind
      </span>
      <div class="ml-auto flex items-center gap-1">
        <UButton
          v-for="r in PLAYBACK_RATES"
          :key="r"
          :data-test="`rate-${r}`"
          size="xs"
          color="neutral"
          :variant="rate === r ? 'soft' : 'ghost'"
          :aria-pressed="rate === r"
          @click="emit('rate', r)"
        >
          {{ r }}×
        </UButton>
        <UButton
          data-test="live"
          size="xs"
          icon="i-lucide-radio"
          :color="mode === 'live' ? 'error' : 'neutral'"
          :variant="mode === 'live' ? 'soft' : 'outline'"
          :aria-pressed="mode === 'live'"
          @click="emit('live')"
        >
          Live
        </UButton>
      </div>
    </div>
  </div>
</template>
