<script setup lang="ts">
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import { revealedOverDisk, revealedVertexCount } from '#shared/utils/terrain'
import type { MissionStateJson } from '~/composables/useMissionState'
import type { PlanGround } from '~/workers/plan-protocol'
import PickPreview from './PickPreview.vue'
import StopMap from './StopMap.vue'

type State = MissionStateJson

const props = withDefaults(
  defineProps<{
    /** Mount one per stop (key on mission and stop index): the terrain loads once, at setup. */
    state: State
    signedIn?: boolean
    /** A submission whose route to show, in place of hover previews. */
    highlight?: { id: string; goal: MapPoint } | null
    /** The rover as playback shows it; at the current stop without one. */
    rover?: { x: number; y: number; headingRad: number }
    /** The route the playing segment follows at the playback time. */
    plan?: MapPoint[]
    /** Where the playing segment has driven so far. */
    driven?: MapPoint[]
    /**
     * Vertices the playing drive has seen so far, as disk-grid indices of this stop's disk: shown
     * lifted from the fog, never given to the planner, which knows only the stop's mask.
     */
    reveals?: readonly { vertices: ArrayLike<number> }[]
  }>(),
  {
    signedIn: false,
    highlight: null,
    rover: undefined,
    plan: () => [],
    driven: () => [],
    reveals: () => [],
  },
)

const emit = defineEmits<{
  submitted: []
  /** The stop's ground once loaded, and the area the journey has revealed so far. */
  ground: [
    ground: {
      grid: HeightGrid
      origin: GridCell
      revealed: Uint8Array
      cellSize: number
      slopeLimitDeg: number
      revealedM2: number
    },
  ]
}>()

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

watch(
  revealed,
  (seen) => {
    const t = terrain.value
    const m = mask.value
    const stopManifest = manifest.value
    if (!seen || !t || !m || !stopManifest) return
    const cellSize = t.grid.cellSize
    emit('ground', {
      grid: t.grid,
      origin: t.origin,
      revealed: seen,
      cellSize,
      slopeLimitDeg: stopManifest.world.slopeLimitDeg,
      revealedM2: revealedVertexCount(m) * cellSize * cellSize,
    })
  },
  { immediate: true },
)

/** The fog as shown: the stop's mask with what the playing drive has seen so far lifted. */
const shownSeen = computed(() => {
  const base = revealed.value
  if (!base || props.reveals.length === 0) return base
  const seen = base.slice()
  for (const group of props.reveals) {
    for (let n = 0; n < group.vertices.length; n++) {
      const k = group.vertices[n]!
      if (k < seen.length) seen[k] = 1
    }
  }
  return seen
})

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

const rover = computed(() => props.rover ?? { x: stop.x, y: stop.y, headingRad: stop.headingRad })

const submissions = computed(() =>
  (props.state.round?.submissions ?? []).map((s) => ({ id: s.id, goal: s.goal })),
)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <div class="space-y-2">
      <StopMap
        :terrain="terrain"
        :seen="shownSeen"
        :center="manifest ? { x: manifest.stop.x, y: manifest.stop.y } : { x: stop.x, y: stop.y }"
        :radius="manifest?.radius ?? 500"
        :anchor="state.round ? anchor : undefined"
        :ring="rules.segmentDistanceBand"
        :rover="rover"
        :trail="state.trail"
        :plan="plan"
        :driven="driven"
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
      <slot name="controls" />
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
