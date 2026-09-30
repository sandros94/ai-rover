<script setup lang="ts">
import type {
  DrivenPoint,
  GroundView,
  MapObject,
  PreviewResult,
  RoverObject,
} from '#shared/utils/client'
import { groundAround } from '#shared/utils/client'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import type { MapViewMode } from '~/composables/useMapView'
import type { StageWait } from '~/utils/stage-wait'
import type { StopFog } from '~/composables/useStopFog'
import StopMap from './StopMap.vue'
import TerrainProgress from './TerrainProgress.vue'

const BLANK = 'h-full w-full bg-(--ui-bg-muted)'

// Its own chunk: three.js loads only when a visitor turns to 3D.
const DiskScene = defineAsyncComponent({
  loader: () =>
    // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
    import('~/components/scene/DiskScene.vue').then((module) => module.default),
  loadingComponent: { render: () => h('div', { class: BLANK }) },
})

/**
 * A stop disk drawn flat or in 3D, filling its box: the same rover, route, path driven, past
 * stops, deaths and fog in both, and the survey's ring. Picking is 2D only; the page owns the
 * switch.
 */
const props = withDefaults(
  defineProps<{
    view: MapViewMode
    /** The disk once every chunk is in; loading progress shows until then. */
    terrain?: { grid: HeightGrid; origin: GridCell }
    /** The disk as it arrives, which both views draw chunk by chunk; by default `terrain`. */
    ground?: GroundView
    /** The stop's own seen flags, one byte per disk vertex; read only without `fog`. */
    seen?: Uint8Array
    /** What the playing drive has seen so far, as disk-grid indices; read only without `fog`. */
    reveals?: readonly { vertices: ArrayLike<number> }[]
    /** The stop's fog, sight included, from an owner that shares it across views. */
    fog?: StopFog
    /** Vertices per chunk side; the 3D view needs it with the ground. */
    chunkVertices?: number
    heightAt: (x: number, y: number) => number | undefined
    loading: { loaded: number; total: number; error: unknown }
    /**
     * Whether this stage shows the terrain's loading progress; false for a stage beside another
     * of the same stop and loader, which shows it for both.
     */
    progress?: boolean
    center: MapPoint
    radius: number
    /**
     * The rover's eye height above the ground, metres; without it no ground is in sight. Read
     * only without `fog`.
     */
    mastHeight?: number
    rover: { x: number; y: number; headingRad: number }
    /**
     * Whether the rover rests at `rover`, no drive playing; while one plays, the 3D view poses it
     * by `frame` and draws none until that frame is in.
     */
    resting?: boolean
    /** The stops shown, the one the rover stands at or left from `current`. */
    trail?: (MapPoint & { current?: boolean })[]
    plan?: MapPoint[]
    /** The path driven so far, drawn on both views. */
    driven?: DrivenPoint[]
    deaths?: MapPoint[]
    deathRadiusM?: number
    /** For the 3D rover and path: the playback frame and the sim time. */
    frame?: Float32Array
    t?: number
    submissions?: { id: string; goal: MapPoint; mine?: boolean }[]
    highlightId?: string | null
    preview?: PreviewResult
    picked?: MapPoint | null
    /**
     * What can be inspected on both views: stops, deaths, submissions and the destination, a
     * list that changes with the mission state; and the rover, which moves every frame.
     */
    objects?: readonly MapObject[]
    roverObject?: RoverObject
    /** Time of the sol shown, 0.5 noon, for the 3D sun; the scene's own default without it. */
    solFraction?: number
  }>(),
  {
    terrain: undefined,
    ground: undefined,
    seen: undefined,
    reveals: () => [],
    fog: undefined,
    chunkVertices: undefined,
    progress: true,
    mastHeight: undefined,
    resting: true,
    trail: () => [],
    plan: () => [],
    driven: () => [],
    deaths: () => [],
    deathRadiusM: 30,
    frame: undefined,
    t: 0,
    submissions: () => [],
    highlightId: null,
    preview: undefined,
    picked: null,
    objects: () => [],
    roverObject: undefined,
    solFraction: undefined,
  },
)

const emit = defineEmits<{ pick: [point: MapPoint]; hover: [point: MapPoint | null] }>()

/** The survey for the 3D view, one object while it stays, so the scene does not redraw its ring. */
const survey = computed<{ center: MapPoint; radius: number }>((previous) => {
  const { center, radius } = props
  if (previous?.center.x === center.x && previous.center.y === center.y) {
    if (previous.radius === radius) return previous
  }
  return { center: { x: center.x, y: center.y }, radius }
})

const NO_REVEALS: readonly { vertices: ArrayLike<number> }[] = []
/*
 * The fog depends on the ground and the rover, never on the view: an owner drawing the stop in
 * more than one view computes it once and hands it to each stage as `fog`. Without it the stage
 * computes its own, whose inputs stay empty while one is handed, so it costs nothing then.
 */
const own = useStopFog({
  seen: () => (props.fog ? undefined : props.seen),
  reveals: () => (props.fog ? NO_REVEALS : props.reveals),
  ground: () => (props.fog ? undefined : (props.ground ?? props.terrain)),
  eye: () => (props.fog ? undefined : props.rover),
  sight: () =>
    props.fog || props.mastHeight === undefined
      ? undefined
      : { mastHeight: props.mastHeight, radiusM: props.radius },
})
const fog = computed(() => props.fog ?? own.value)

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
/** Where the 3D rover stands: at the playback frame, else at rest; nowhere while a frame is due. */
const standing = computed(() => {
  const frame = props.frame
  if (frame) return { x: frame[X]!, y: frame[Y]! }
  return props.resting ? props.rover : undefined
})
/** The terrain's chunks, counted. */
const chunks = computed<StageWait>(() => ({
  what: 'terrain',
  loaded: props.loading.loaded,
  total: props.loading.total,
}))
/** The terrain's chunks while they arrive; undefined once every one is in. */
const terrainWait = computed(() => (props.terrain ? undefined : chunks.value))
/**
 * What keeps the ground the 3D rover stands on from being known and drawn true, so the rover and
 * the path it drove may be drawn on it: the stop's mask (a playback frame comes only with the
 * drive's reveals up to it, which the fog lifts settled with it), the drive's first frame while
 * one plays, and the chunks under and around the rover. Undefined once it is.
 */
const unmet = computed<StageWait | undefined>(() => {
  const view = props.ground ?? props.terrain
  if (!view || !props.chunkVertices) return chunks.value
  const masked = props.fog ? !!props.fog.fade : props.seen === undefined || !!own.value.fade
  if (!masked) return { what: 'mask' }
  const at = standing.value
  if (!at) return { what: 'drive' }
  const survey = { center: props.center, radius: props.radius }
  return groundAround(view, at, { chunkVertices: props.chunkVertices, survey })
    ? undefined
    : chunks.value
})
const grounded = computed(() => !unmet.value)
/** What the 3D view waits for: every chunk, then the ground under the rover known. */
const sceneWait = computed(() => terrainWait.value ?? unmet.value)
</script>

<template>
  <div class="relative h-full w-full">
    <StopMap
      v-if="view === '2d'"
      :terrain="ground ?? terrain"
      :fog="fog"
      :center="center"
      :radius="radius"
      :rover="rover"
      :trail="trail"
      :plan="plan"
      :driven="driven"
      :deaths="deaths"
      :death-radius-m="deathRadiusM"
      :submissions="submissions"
      :highlight-id="highlightId"
      :preview="preview"
      :picked="picked"
      :objects="objects"
      :rover-object="roverObject"
      @hover="emit('hover', $event)"
      @pick="emit('pick', $event)"
    >
      <TerrainProgress v-if="progress" :waiting="terrainWait" :error="loading.error" />
    </StopMap>
    <DiskScene
      v-else-if="(ground ?? terrain) && chunkVertices"
      :terrain="(ground ?? terrain)!"
      :fog="fog"
      :survey="survey"
      :chunk-vertices="chunkVertices"
      :height-at="heightAt"
      :frame="frame"
      :rest="rover"
      :grounded="grounded"
      :driven="grounded ? driven : []"
      :t="t"
      :route="plan"
      :stops="trail"
      :deaths="deaths"
      :death-radius-m="deathRadiusM"
      :objects="objects"
      :rover-object="roverObject"
      :lighting="{ solFraction }"
    />
    <div v-else :class="['relative', BLANK]">
      <TerrainProgress v-if="progress" :waiting="chunks" :error="loading.error" />
    </div>
    <TerrainProgress
      v-if="progress && view !== '2d' && ground && chunkVertices"
      :waiting="sceneWait"
      :error="loading.error"
    />
  </div>
</template>
