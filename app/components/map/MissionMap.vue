<script setup lang="ts">
import type { KeyframeBlock } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import { revealedVertexCount } from '#shared/utils/terrain'
import type { MissionStateJson } from '~/composables/useMissionState'
import type { PlanGround } from '~/workers/plan-protocol'
import PickPreview from './PickPreview.vue'
import StopStage from './StopStage.vue'

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
    /** For the 3D view: the playback frame, the keyframes reached and the sim time. */
    frame?: Float32Array
    keyframes?: KeyframeBlock
    t?: number
  }>(),
  {
    signedIn: false,
    highlight: null,
    rover: undefined,
    plan: () => [],
    driven: () => [],
    reveals: () => [],
    frame: undefined,
    keyframes: undefined,
    t: 0,
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

const { manifest, mask, cache, sampler, loaded, total, terrain, revealed, error } = useStopTerrain(
  props.state.mission.id,
  stop.index,
  {
    center: anchor.value,
    ring: rules.value.segmentDistanceBand,
  },
)
const view = useMapView()
const heightAt = (x: number, y: number) => sampler.value?.heightAt(x, y)

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

const { picked, submitting, refusal, onHover, onPick, cancel, confirm } = usePickSubmit(preview, {
  highlight: () => props.highlight,
  onSubmitted: () => emit('submitted'),
})

const rover = computed(() => props.rover ?? { x: stop.x, y: stop.y, headingRad: stop.headingRad })

const submissions = computed(() =>
  (props.state.round?.submissions ?? []).map((s) => ({ id: s.id, goal: s.goal })),
)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <div class="space-y-2">
      <StopStage
        v-model:view="view"
        :terrain="terrain"
        :seen="revealed"
        :reveals="reveals"
        :chunk-vertices="cache?.geometry?.vertexCount"
        :height-at="heightAt"
        :loading="{ loaded, total, error }"
        :center="manifest ? { x: manifest.stop.x, y: manifest.stop.y } : { x: stop.x, y: stop.y }"
        :radius="manifest?.radius ?? 500"
        :rover="rover"
        :trail="state.trail"
        :plan="plan"
        :driven="driven"
        :deaths="state.deaths"
        :death-radius-m="rules.failureZone.destinationRadiusM"
        :frame="frame"
        :keyframes="keyframes"
        :t="t"
        :anchor="state.round ? anchor : undefined"
        :ring="rules.segmentDistanceBand"
        :submissions="submissions"
        :highlight-id="highlight?.id ?? null"
        :preview="preview.result.value"
        :picked="picked"
        @hover="onHover"
        @pick="onPick"
      />
      <slot name="controls" />
    </div>
    <div class="space-y-4">
      <PickPreview
        v-if="view === '2d'"
        :result="preview.result.value"
        :pending="preview.pending.value"
        :picked="picked !== null"
        :submitting="submitting"
        :refusal="refusal"
        :signed-in="signedIn"
        @confirm="confirm"
        @cancel="cancel"
      />
      <UAlert
        v-else
        data-test="plan-hint"
        color="neutral"
        variant="subtle"
        icon="i-lucide-map"
        title="Switch to 2D to plan"
        description="Destinations are picked on the flat map, inside the ring around the goal."
      />
      <slot />
    </div>
  </div>
</template>
