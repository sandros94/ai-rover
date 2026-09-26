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
    /** Replay holds its sim time. */
    paused?: boolean
    /** Offer the return to live; a settled drive's replay has no live edge worth following. */
    live?: boolean
  }>(),
  { lagS: null, paused: false, live: true },
)

const emit = defineEmits<{
  seek: [simSeconds: number]
  rate: [rate: PlaybackRate]
  /** Pause, or play on from the pause. */
  toggle: []
  live: []
}>()

const max = computed(() => Math.max(1, Math.round(props.releasedUntil)))
const position = computed(() => Math.min(max.value, Math.max(0, props.simTime)))

/** Phones get one button stepping through the rates in place of the row of them. */
const nextRate = computed(
  () => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(props.rate) + 1) % PLAYBACK_RATES.length]!,
)

function onScrub(value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) emit('seek', value)
}
</script>

<template>
  <div
    class="flex w-full max-w-2xl items-center gap-2 rounded-lg bg-(--ui-bg)/90 p-1.5 text-xs shadow-lg ring ring-(--ui-border) backdrop-blur-sm"
    data-test="playback"
  >
    <UButton
      data-test="play-toggle"
      :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
      :aria-label="paused ? 'Play' : 'Pause'"
      size="xs"
      color="neutral"
      variant="ghost"
      @click="emit('toggle')"
    />
    <span class="font-mono tabular-nums" data-test="sim-time">{{ formatDuration(position) }}</span>
    <USlider
      class="min-w-16 flex-1"
      :model-value="position"
      :min="0"
      :max="max"
      :step="1"
      size="sm"
      aria-label="Playback position"
      @update:model-value="onScrub"
    />
    <span class="hidden text-muted sm:inline">{{ formatDuration(max) }}</span>
    <span v-if="lagS !== null" class="hidden text-muted md:inline" data-test="lag">
      {{ Math.max(0, Math.round(lagS)) }} s behind
    </span>
    <div class="hidden items-center gap-0.5 sm:flex">
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
    </div>
    <UButton
      class="sm:hidden"
      data-test="rate-cycle"
      size="xs"
      color="neutral"
      variant="soft"
      :aria-label="`Speed ${rate}×, change to ${nextRate}×`"
      @click="emit('rate', nextRate)"
    >
      {{ rate }}×
    </UButton>
    <UButton
      v-if="live"
      data-test="live"
      size="xs"
      icon="i-lucide-radio"
      aria-label="Live"
      :color="mode === 'live' ? 'error' : 'neutral'"
      :variant="mode === 'live' ? 'soft' : 'outline'"
      :aria-pressed="mode === 'live'"
      @click="emit('live')"
    >
      <span class="hidden sm:inline">Live</span>
    </UButton>
  </div>
</template>
