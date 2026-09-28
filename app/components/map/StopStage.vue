<script setup lang="ts">
import type { GroundView, MapObject, PreviewResult, RoverObject } from '#shared/utils/client'
import { liftSeen } from '#shared/utils/client'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import type { MapViewMode } from '~/composables/useMapView'
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
 * stops, deaths and fog in both. Picking and the pick ring are 2D only; the page owns the switch.
 */
const props = withDefaults(
  defineProps<{
    view: MapViewMode
    /** The disk once every chunk is in; loading progress shows until then. */
    terrain?: { grid: HeightGrid; origin: GridCell }
    /** The disk as it arrives, which both views draw chunk by chunk; by default `terrain`. */
    ground?: GroundView
    /** The stop's own seen flags, one byte per disk vertex. */
    seen?: Uint8Array
    /** What the playing drive has seen so far, as disk-grid indices, lifted from the fog. */
    reveals?: readonly { vertices: ArrayLike<number> }[]
    /** Vertices per chunk side; the 3D view needs it with the ground. */
    chunkVertices?: number
    heightAt: (x: number, y: number) => number | undefined
    loading: { loaded: number; total: number; error: unknown }
    center: MapPoint
    radius: number
    /** The rover's eye height above the ground, metres; without it no ground is in sight. */
    mastHeight?: number
    rover: { x: number; y: number; headingRad: number }
    /** The stops shown, the one the rover stands at or left from `current`. */
    trail?: (MapPoint & { current?: boolean })[]
    plan?: MapPoint[]
    driven?: MapPoint[]
    deaths?: MapPoint[]
    deathRadiusM?: number
    /** For the 3D rover and path: the playback frame, the keyframes reached, the sim time. */
    frame?: Float32Array
    keyframes?: KeyframeBlock
    t?: number
    anchor?: MapPoint
    ring?: { minM: number; maxM: number }
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
  }>(),
  {
    terrain: undefined,
    ground: undefined,
    seen: undefined,
    reveals: () => [],
    chunkVertices: undefined,
    mastHeight: undefined,
    trail: () => [],
    plan: () => [],
    driven: () => [],
    deaths: () => [],
    deathRadiusM: 30,
    frame: undefined,
    keyframes: undefined,
    t: 0,
    anchor: undefined,
    ring: undefined,
    submissions: () => [],
    highlightId: null,
    preview: undefined,
    picked: null,
    objects: () => [],
    roverObject: undefined,
  },
)

const emit = defineEmits<{ pick: [point: MapPoint]; hover: [point: MapPoint | null] }>()

/** The 2D fog: the stop's flags with the drive's reveals lifted; the 3D view lifts its own. */
const shownSeen = computed(() => props.seen && liftSeen(props.seen, props.reveals))

/** What the rover has in line of sight now over what has been revealed, across the whole disk. */
const sight = useCurrentSight(
  () => shownSeen.value,
  () => props.ground ?? props.terrain,
  () => props.rover,
  () =>
    props.mastHeight === undefined
      ? undefined
      : { mastHeight: props.mastHeight, radiusM: props.radius },
)
</script>

<template>
  <div class="relative h-full w-full">
    <StopMap
      v-if="view === '2d'"
      :terrain="ground ?? terrain"
      :seen="shownSeen"
      :sight="sight"
      :center="center"
      :radius="radius"
      :anchor="anchor"
      :ring="ring"
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
      <TerrainProgress :ready="!!terrain" v-bind="loading" />
    </StopMap>
    <DiskScene
      v-else-if="(ground ?? terrain) && chunkVertices"
      :terrain="(ground ?? terrain)!"
      :seen="seen"
      :sight="sight"
      :chunk-vertices="chunkVertices"
      :height-at="heightAt"
      :frame="frame"
      :rest="rover"
      :keyframes="keyframes"
      :t="t"
      :route="plan"
      :stops="trail"
      :deaths="deaths"
      :death-radius-m="deathRadiusM"
      :reveals="reveals"
      :objects="objects"
      :rover-object="roverObject"
    />
    <div v-else :class="['relative', BLANK]">
      <TerrainProgress :ready="false" v-bind="loading" />
    </div>
    <TerrainProgress
      v-if="view !== '2d' && ground && chunkVertices"
      :ready="!!terrain"
      v-bind="loading"
    />
  </div>
</template>
