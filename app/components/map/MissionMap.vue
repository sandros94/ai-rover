<script lang="ts">
import type { Ref } from 'vue'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'

/**
 * What playback shows on the map, as refs read where they are drawn: the rover and the frame
 * change every animation frame, and reading them here would redraw every slot with them.
 */
export interface MapTrack {
  /** The rover as playback shows it; at the current stop without one. */
  rover: Ref<{ x: number; y: number; headingRad: number } | undefined>
  /** The route the playing segment follows at the playback time. */
  plan: Ref<MapPoint[]>
  /** Where the playing segment has driven so far. */
  driven: Ref<MapPoint[]>
  /**
   * Vertices the playing drive has seen so far, as disk-grid indices of this stop's disk: shown
   * lifted from the fog, never given to the planner, which knows only the stop's mask.
   */
  reveals: Ref<readonly { vertices: ArrayLike<number> }[]>
  /** For the 3D view: the playback frame, the keyframes reached and the sim time. */
  frame: Ref<Float32Array | undefined>
  keyframes: Ref<KeyframeBlock | undefined>
  t: Ref<number>
  /** The rover's speed and share of the segment driven, for its card; none without a drive. */
  motion: Ref<{ speedMps: number; progress: number | null } | undefined>
  /** Time of the sol the view shows, for the 3D sun. */
  solFraction: Ref<number | undefined>
}
</script>

<script setup lang="ts">
import type { MapObject } from '#shared/utils/client'
import { chunkVerticesOf, roverObject, roverStatus } from '#shared/utils/client'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import { revealedVertexCount } from '#shared/utils/terrain'
import type { MissionStateJson } from '~/composables/useMissionState'
import type { PlanGround } from '~/workers/plan-protocol'
import type { StageProps } from './LiveStage.vue'

type State = MissionStateJson

/*
 * The current stop's ground and pick flow, drawn by the slot: `stage` reads the stage's props
 * (hand it to `LiveStage`), `planning` is the pick flow as `PickPreview` shows it.
 */

const props = withDefaults(
  defineProps<{
    /** Mount one per stop (key on mission and stop index): the terrain loads once, at setup. */
    state: State
    signedIn?: boolean
    /** A submission whose route to show, in place of hover previews. */
    highlight?: { id: string; goal: MapPoint } | null
    track: MapTrack
    /**
     * The state's stops, deaths, submissions and the drive's destination, to draw and inspect;
     * the rover is added here.
     */
    objects: readonly MapObject[]
  }>(),
  { signedIn: false, highlight: null },
)

const emit = defineEmits<{
  submitted: []
  /** The server refused a pick because the round moved: the mission state is out of date. */
  stale: []
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

const {
  manifest,
  mask,
  sampler,
  loaded,
  total,
  ground: arriving,
  terrain,
  revealed,
  error,
} = useStopTerrain(props.state.mission.id, stop.index, { center: anchor.value })
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
  onStale: () => emit('stale'),
})

const deathObjects = computed(() => props.objects.filter((o) => o.kind === 'death'))

/** The trail with its current stop marked; apart from the stage, which changes every frame. */
const trail = computed(() =>
  props.state.trail.map((s) => ({ x: s.x, y: s.y, current: s.index === stop.index })),
)

/** The rover as playback shows it, else at the stop; changes every animation frame. */
const rover = computed(
  () => props.track.rover.value ?? { x: stop.x, y: stop.y, headingRad: stop.headingRad },
)

/** Once for every stage the slot draws: the fog, sight included, is the same in each view. */
const fog = useStopFog({
  seen: () => revealed.value,
  reveals: () => props.track.reveals.value,
  ground: () => arriving.value ?? terrain.value,
  eye: () => rover.value,
  sight: () => {
    const m = manifest.value
    return m && { mastHeight: m.world.mastHeight, radiusM: m.radius }
  },
})

const submissions = computed(() =>
  (props.state.round?.submissions ?? []).map((s) => ({ id: s.id, goal: s.goal })),
)

/** The stage's props: changes every animation frame while a drive plays. */
const stage = computed((): StageProps => {
  const { track } = props
  const status = roverStatus(props.state)
  const motion = status === 'driving' ? track.motion.value : undefined
  return {
    terrain: terrain.value,
    ground: arriving.value,
    fog: fog.value,
    chunkVertices: manifest.value && chunkVerticesOf(manifest.value),
    heightAt,
    loading: { loaded: loaded.value, total: total.value, error: error.value },
    center: manifest.value
      ? { x: manifest.value.stop.x, y: manifest.value.stop.y }
      : { x: stop.x, y: stop.y },
    radius: manifest.value?.radius ?? 500,
    mastHeight: manifest.value?.world.mastHeight,
    rover: rover.value,
    trail: trail.value,
    plan: track.plan.value,
    driven: track.driven.value,
    // The deaths as objects: the 3D view knows each ghost by its id.
    deaths: deathObjects.value,
    deathRadiusM: rules.value.failureZone.destinationRadiusM,
    frame: track.frame.value,
    keyframes: track.keyframes.value,
    t: track.t.value,
    submissions: submissions.value,
    highlightId: props.highlight?.id ?? null,
    preview: preview.result.value,
    picked: picked.value,
    objects: props.objects,
    solFraction: track.solFraction.value,
    roverObject: roverObject(rover.value, {
      status,
      speedMps: motion?.speedMps ?? null,
      progress: motion?.progress ?? null,
    }),
  }
})
/** Read by `LiveStage` where it draws, so only the stage redraws every frame. */
const readStage = () => stage.value

const planning = reactive({
  result: preview.result,
  pending: preview.pending,
  picked: computed(() => picked.value !== null),
  submitting,
  refusal,
  onHover,
  onPick,
  confirm,
  cancel,
})
</script>

<template>
  <slot :stage="readStage" :planning="planning" />
</template>
