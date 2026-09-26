<script setup lang="ts">
import type { MapPoint } from '#shared/utils/mission'
import { revealedOverDisk } from '#shared/utils/terrain'
import type { MissionStateJson } from '~/composables/useMissionState'
import type { PlanGround } from '~/workers/plan-protocol'
import PickPreview from './PickPreview.vue'
import SegmentRover from './SegmentRover.vue'
import StopMap from './StopMap.vue'

type State = MissionStateJson

const props = withDefaults(
  defineProps<{
    /** Mount one per stop (key on mission and stop index): the terrain loads once, at setup. */
    state: State
    serverOffsetMs?: number
    signedIn?: boolean
    /** A submission whose route to show, in place of hover previews. */
    highlight?: { id: string; goal: MapPoint } | null
  }>(),
  { serverOffsetMs: 0, signedIn: false, highlight: null },
)

const emit = defineEmits<{ submitted: [] }>()

const stop = props.state.currentStop
const anchor = computed<MapPoint>(() => props.state.round?.anchor ?? { x: stop.x, y: stop.y })
const rules = computed(() => props.state.mission.rules)

const { manifest, mask, sampler, loaded, total, error } = useStopTerrain(
  props.state.mission.id,
  stop.index,
  { center: anchor.value, ring: rules.value.segmentDistanceBand },
)

/** The whole disk, once every chunk it lists has arrived. */
const terrain = computed(() => {
  if (!manifest.value || !sampler.value || total.value === 0 || loaded.value < total.value) {
    return undefined
  }
  return sampler.value.assembleDiskGrid(manifest.value)
})
const revealed = computed(() =>
  terrain.value && mask.value ? revealedOverDisk(mask.value, terrain.value) : undefined,
)

const ground = computed<PlanGround | undefined>(() => {
  const m = manifest.value
  const t = terrain.value
  const r = revealed.value
  if (!m || !t || !r) return undefined
  return {
    grid: t.grid,
    origin: t.origin,
    traversable: t.traversable,
    revealed: r,
    center: { x: m.stop.x, y: m.stop.y },
    radius: m.radius,
    chunks: m.chunks.map(({ cx, cy }) => ({ cx, cy })),
    mastHeight: m.world.mastHeight,
    slopeLimitDeg: m.world.slopeLimitDeg,
  }
})
const context = computed(() => ({
  anchor: anchor.value,
  deaths: props.state.deaths,
  rules: rules.value,
}))

const preview = usePlanPreview(ground, context)

const picked = ref<MapPoint | null>(null)
const submitting = ref(false)
const refusal = ref<{ reason: string; message: string } | null>(null)

function onHover(point: MapPoint | null): void {
  if (picked.value || props.highlight) return
  if (point) preview.request(point)
}

function onPick(point: MapPoint): void {
  picked.value = point
  refusal.value = null
  preview.requestNow(point)
}

function cancel(): void {
  picked.value = null
  refusal.value = null
  preview.clear()
}

watch(
  () => props.highlight,
  (highlight) => {
    picked.value = null
    refusal.value = null
    if (highlight) preview.requestNow(highlight.goal)
    else preview.clear()
  },
)

async function confirm(): Promise<void> {
  if (!picked.value) return
  submitting.value = true
  refusal.value = null
  try {
    await $fetch('/api/mission/submissions', {
      method: 'POST',
      body: { goal: { x: picked.value.x, y: picked.value.y } },
    })
    cancel()
    emit('submitted')
  } catch (caught) {
    const data = (caught as { data?: { reason?: string; code?: string; message?: string } }).data
    refusal.value = {
      reason: data?.reason ?? data?.code ?? 'error',
      message: data?.message ?? (caught instanceof Error ? caught.message : String(caught)),
    }
  } finally {
    submitting.value = false
  }
}

const livePose = shallowRef<{ x: number; y: number; headingRad: number }>()
const livePlan = shallowRef<MapPoint[]>([])
const driving = computed(() => props.state.segment)
watch(
  () => driving.value?.id,
  () => {
    livePose.value = undefined
    livePlan.value = []
  },
)
const rover = computed(
  () => livePose.value ?? { x: stop.x, y: stop.y, headingRad: stop.headingRad },
)

const submissions = computed(() =>
  (props.state.round?.submissions ?? []).map((s) => ({ id: s.id, goal: s.goal })),
)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <div class="space-y-2">
      <StopMap
        :terrain="terrain"
        :seen="revealed"
        :center="manifest ? { x: manifest.stop.x, y: manifest.stop.y } : { x: stop.x, y: stop.y }"
        :radius="manifest?.radius ?? 500"
        :anchor="state.round ? anchor : undefined"
        :ring="rules.segmentDistanceBand"
        :rover="rover"
        :trail="state.trail"
        :plan="livePlan"
        :deaths="state.deaths"
        :death-radius-m="rules.failureZone.destinationRadiusM"
        :submissions="submissions"
        :highlight-id="highlight?.id ?? null"
        :preview="preview.result.value"
        :picked="picked"
        @hover="onHover"
        @pick="onPick"
      >
        <div
          v-if="!terrain"
          class="absolute inset-x-4 bottom-4 space-y-1 rounded-md bg-(--ui-bg)/80 p-2 text-xs"
        >
          <p v-if="error" class="text-error">The terrain did not load: {{ String(error) }}</p>
          <template v-else>
            <p class="text-muted">Loading terrain {{ loaded }} / {{ total || '…' }}</p>
            <UProgress :model-value="total ? (100 * loaded) / total : null" size="xs" />
          </template>
        </div>
      </StopMap>
      <SegmentRover
        v-if="driving"
        :key="driving.id"
        :segment-id="driving.id"
        :server-offset-ms="serverOffsetMs"
        @pose="livePose = $event"
        @plan="livePlan = $event"
      />
    </div>
    <div class="space-y-4">
      <PickPreview
        :result="preview.result.value"
        :pending="preview.pending.value"
        :picked="picked !== null"
        :submitting="submitting"
        :refusal="refusal"
        :signed-in="signedIn"
        @confirm="confirm"
        @cancel="cancel"
      />
      <slot />
    </div>
  </div>
</template>
