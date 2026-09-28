<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { navigateTo, useRoute } from '#imports'
import type { SegmentRecord } from '#shared/utils/drive'
import { interpolatePose } from '#shared/utils/drive'
import type { DiskWire } from '../../shared/disk-wire'
import { decodeDiskWire } from '../../shared/disk-wire'
import type { SegmentRecordJson } from '../../shared/record-json'
import { jsonToRecord } from '../../shared/record-json'
import { fixtureContext, scrubContext } from '../playground/fixtures'
import type { PlaygroundEntry } from '../playground/registry'

const props = defineProps<{ entry: PlaygroundEntry }>()

/** Sim seconds per wall-clock second. */
const SPEEDS = [1, 10, 60, 200]

const view = defineAsyncComponent(props.entry.component)
const route = useRoute()
const fixtures = ref<string[]>([])
const selected = computed(() =>
  typeof route.query.fixture === 'string' ? route.query.fixture : fixtures.value[0],
)
const record = shallowRef<SegmentRecord | null>(null)
const disk = shallowRef<DiskWire>()
const loading = ref(false)
const error = ref<string | null>(null)
const t = ref(0)
const speed = ref(60)
const playing = ref(false)

const duration = computed(() => record.value?.outcome.durationS ?? 0)
const frame = computed(() => record.value && interpolatePose(record.value.keyframes, t.value))
const events = computed(() => record.value?.events.filter((event) => event.t <= t.value) ?? [])
const recordContext = computed(() => record.value && fixtureContext(record.value, disk.value))
const bound = computed(() => {
  if (!record.value || !frame.value || !recordContext.value) return undefined
  const base = { record: record.value, frame: frame.value, events: events.value, disk: disk.value }
  if (!props.entry.bind) return base
  return props.entry.bind({
    ...recordContext.value,
    ...base,
    t: t.value,
    ...scrubContext(record.value, t.value),
  })
})
/** Scrub time to open at, from `?t=` in seconds: repeatable screenshots mid-drive. */
const startAt = computed(() => {
  const value = Number(route.query.t)
  return Number.isFinite(value) && value > 0 ? value : 0
})

function select(name: string): void {
  void navigateTo({ query: { ...route.query, fixture: name } }, { replace: true })
}

async function load(name: string | undefined): Promise<void> {
  if (!name) return
  playing.value = false
  loading.value = true
  error.value = null
  try {
    const next = jsonToRecord(
      await $fetch<SegmentRecordJson>(`/api/_dev/fixtures/${encodeURIComponent(name)}`),
    )
    // Fixture names are world seeds, so the disk comes from the same world and start.
    disk.value = props.entry.needs.includes('disk')
      ? decodeDiskWire(
          await $fetch<ArrayBuffer>('/api/_dev/disk', {
            query: { seed: name, x: next.start.x, y: next.start.y },
            responseType: 'arrayBuffer',
          }),
        )
      : undefined
    record.value = next
    t.value = Math.min(startAt.value, next.outcome.durationS)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

let raf = 0
let last = 0
function tick(now: number): void {
  t.value = Math.min(duration.value, t.value + ((now - last) / 1000) * speed.value)
  last = now
  if (t.value >= duration.value) playing.value = false
  else raf = requestAnimationFrame(tick)
}
watch(playing, (on) => {
  cancelAnimationFrame(raf)
  if (!on) return
  if (t.value >= duration.value) t.value = 0
  last = performance.now()
  raf = requestAnimationFrame(tick)
})

// Client-only: typed arrays do not survive the SSR payload.
onMounted(async () => {
  fixtures.value = await $fetch<string[]>('/api/_dev/fixtures')
  watch(selected, load, { immediate: true })
})
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="flex flex-wrap items-center gap-3 border-b border-default px-4 py-2">
      <ULink to="/_dev/playground" class="font-medium">Playground</ULink>
      <span class="text-muted">/ {{ entry.title }}</span>
      <USelect
        :model-value="selected"
        :items="fixtures"
        :loading="loading"
        class="w-32"
        aria-label="Fixture"
        @update:model-value="select"
      />
      <UButton
        :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
        :disabled="!record"
        :aria-label="playing ? 'Pause' : 'Play'"
        @click="playing = !playing"
      />
      <UFieldGroup>
        <UButton
          v-for="rate in SPEEDS"
          :key="rate"
          :variant="rate === speed ? 'solid' : 'outline'"
          color="neutral"
          @click="speed = rate"
        >
          {{ rate }}×
        </UButton>
      </UFieldGroup>
      <USlider
        v-model="t"
        :min="0"
        :max="duration"
        :step="0.1"
        :disabled="!record"
        class="min-w-48 flex-1"
      />
      <span class="font-mono text-sm">
        <span class="readout min-w-[6ch]">{{ t.toFixed(1) }}</span> /
        <span class="readout min-w-[6ch]">{{ duration.toFixed(1) }}</span> s ·
        <span class="readout min-w-[4ch]">{{ events.length }}</span> events
      </span>
    </header>
    <main class="flex-1 p-6">
      <UAlert v-if="error" color="error" :title="error" />
      <div v-else-if="bound" :class="{ 'max-w-2xl': entry.group === 'instrument' }">
        <component :is="view" v-bind="bound" />
      </div>
      <p v-else class="text-muted">Loading fixture…</p>
    </main>
  </div>
</template>
