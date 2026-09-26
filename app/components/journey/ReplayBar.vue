<script setup lang="ts">
/**
 * Ways into a replay of several segments back to back: what ended since this browser last
 * replayed to the end, the last day, the last week, or a range of segment numbers.
 */
const props = defineProps<{
  /** The latest settled segment's number. */
  latest: number
}>()

const DAY_MS = 86_400_000
/** Segments the range offers by default: the latest few. */
const DEFAULT_SPAN = 5

const { until } = useReplayedUntil()

/**
 * Wall-clock to the minute, set once mounted and kept current, so the server render and the
 * first client render agree and a page left open still offers the last day from now.
 */
const now = ref<number | null>(null)
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  const tick = () => (now.value = Math.floor(Date.now() / 60_000) * 60_000)
  tick()
  ticker = setInterval(tick, 60_000)
})
onBeforeUnmount(() => clearInterval(ticker))

const since = (iso: string) => `/drives/replay?since=${encodeURIComponent(iso)}`
const back = (ms: number) =>
  now.value === null ? undefined : since(new Date(now.value - ms).toISOString())

const from = ref(Math.max(1, props.latest - DEFAULT_SPAN + 1))
const to = ref(props.latest)
const range = computed(() => {
  const a = Math.min(from.value, to.value)
  const b = Math.max(from.value, to.value)
  return `/drives/replay?from=${a}&to=${b}`
})
</script>

<template>
  <section
    class="flex flex-wrap items-center gap-2 rounded-lg border border-default p-2 text-sm"
    aria-label="Replay several segments"
    data-test="replay-bar"
  >
    <span class="flex items-center gap-1 font-medium">
      <UIcon name="i-lucide-list-video" class="size-4" /> Replay
    </span>
    <UButton
      v-if="until"
      data-test="replay-last-visit"
      :to="since(until)"
      size="sm"
      color="primary"
      variant="soft"
    >
      Since last visit
    </UButton>
    <UButton
      data-test="replay-day"
      :to="back(DAY_MS)"
      :disabled="now === null"
      size="sm"
      color="neutral"
      variant="soft"
    >
      Last 24 h
    </UButton>
    <UButton
      data-test="replay-week"
      :to="back(7 * DAY_MS)"
      :disabled="now === null"
      size="sm"
      color="neutral"
      variant="soft"
    >
      Last 7 days
    </UButton>
    <span class="flex items-center gap-1 sm:ml-auto">
      <span class="text-muted">Segments</span>
      <UInputNumber
        v-model="from"
        data-test="replay-from"
        :min="1"
        :max="latest"
        size="sm"
        class="w-24"
        aria-label="From segment"
      />
      <span class="text-muted">to</span>
      <UInputNumber
        v-model="to"
        data-test="replay-to"
        :min="1"
        :max="latest"
        size="sm"
        class="w-24"
        aria-label="To segment"
      />
      <UButton
        data-test="replay-range"
        :to="range"
        icon="i-lucide-play"
        size="sm"
        color="neutral"
        variant="outline"
        aria-label="Replay these segments"
      />
    </span>
  </section>
</template>
