<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import { GridHelper, NoToneMapping, Vector3 } from 'three'
import type { GridRect } from '#shared/utils/client'
import type { ChunkFog, TerrainChunk } from '#shared/utils/client/scene'
import {
  FOG_FILL,
  framePlacement,
  fullModelLedger,
  HILLSHADE_LIGHT,
  LOD_FAR_M,
  rgbHex,
} from '#shared/utils/client/scene'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { ResolvedRoverGeometry } from '#shared/utils/rover'
import type { RoverVariant } from '~/composables/useRoverVariant'
import DeathGhosts from './DeathGhosts.vue'
import FollowCamera from './FollowCamera.vue'
import GoalMarkers from './GoalMarkers.vue'
import RouteLine from './RouteLine.vue'
import RoverModel from './RoverModel.vue'
import type { Pickable } from './ScenePicker.vue'
import ScenePicker from './ScenePicker.vue'
import SceneAtmosphere from './SceneAtmosphere.vue'
import TerrainChunks from './TerrainChunks.vue'
import TrailLayer from './TrailLayer.vue'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values at the playback time. */
    frame: Float32Array
    geometry?: ResolvedRoverGeometry
    /** The stop disk's chunks; without any, the rover stands on a flat grid at its own height. */
    chunks?: { chunk: TerrainChunk }[]
    /** Height span of the disk for the colour ramp; required with `chunks`. */
    heightRange?: { min: number; max: number }
    heightAt?: (x: number, y: number) => number | undefined
    /** Height of the ground as drawn, fog included, for the route; by default `heightAt`. */
    drawnHeightAt?: (x: number, y: number) => number | undefined
    stops?: { x: number; y: number }[]
    keyframes?: KeyframeBlock
    /** Sim seconds, for the path driven so far. */
    t?: number
    route?: { x: number; y: number }[]
    deaths?: { x: number; y: number; z: number; headingRad: number; id?: string }[]
    /** Radius of the red circle around each death, metres. */
    deathRadiusM?: number
    /** The stop disk's fog over `chunks`; without it every chunk shows its true ground. */
    fog?: ChunkFog & { rects?: GridRect[] }
    /** The rover to draw; by default the JPL model, the procedural one while it loads or if it fails. */
    roverVariant?: RoverVariant
    /** The open round's goals, on the ground, flagged. */
    goals?: readonly { id: string; x: number; y: number; z: number }[]
    /** What the pointer can inspect; without any, nothing is picked. */
    pickables?: readonly Pickable[]
    /** The focused object's id, and where the camera looks while it is focused (else the rover). */
    focusedId?: string | null
    focusTarget?: { x: number; y: number; z: number }
    /** Changes with every focus, so the camera eases to the new target. */
    focusKey?: number
  }>(),
  {
    geometry: undefined,
    chunks: () => [],
    heightRange: () => ({ min: 0, max: 1 }),
    heightAt: undefined,
    drawnHeightAt: undefined,
    stops: () => [],
    keyframes: undefined,
    t: 0,
    route: () => [],
    deaths: () => [],
    deathRadiusM: undefined,
    fog: undefined,
    roverVariant: undefined,
    goals: () => [],
    pickables: () => [],
    focusedId: null,
    focusTarget: undefined,
    focusKey: 0,
  },
)

const emit = defineEmits<{
  /** The rover drawn changed: the procedural one, or a JPL model once loaded. */
  roverReady: [info: { variant: RoverVariant; triangles: number; loadMs: number }]
  /** The mouse is over an object, or none. */
  hover: [id: string | null, client: { x: number; y: number }]
  /** A tap or click on an object, or on none. */
  tap: [id: string | null, pointerType: string, client: { x: number; y: number }]
}>()

/** The rover and a focused ghost: never more full rover models than that in the scene. */
const ledger = fullModelLedger()

const rover = computed(() => framePlacement(props.frame).position)
const focus = computed(() => ({ x: rover.value.x, y: rover.value.y }))
/** Camera target: the body's middle rather than its ground-level origin, or the focused object. */
const target = computed(() => props.focusTarget ?? { ...rover.value, z: rover.value.z + 1 })

/**
 * Lighting for the rover only (the terrain's shading is baked): the hillshade's sun from the
 * north-west and a sky-to-ground hemisphere fill, so the model's sides away from the sun still
 * read against the ground. A directional light shines from its position towards its target at
 * the world origin, so the position is the direction alone. three.js divides Lambert light by
 * π, hence the factor on the intensities.
 */
const SUN = new Vector3(HILLSHADE_LIGHT.x, HILLSHADE_LIGHT.y, HILLSHADE_LIGHT.z)
/** Fill from a pale dusty sky above and the warm ground below. */
const HEMISPHERE = { sky: '#e8dccb', ground: '#6b5a48' }
/**
 * Sky and distance fog in the colour of unseen ground, so what is too far to make out and what
 * has not been seen look alike. Full detail reaches `LOD_FAR_M`; the fog closes in past it.
 */
const colorMode = useColorMode()
const sky = computed(() => rgbHex(FOG_FILL[colorMode.value === 'dark' ? 'dark' : 'light']))
const HAZE = { near: LOD_FAR_M, far: 4 * LOD_FAR_M }

/** Ground for a scene without terrain: a 1 m grid in the rover's ground plane. */
const plane = new GridHelper(40, 40, '#a8a29e', '#57534e')
plane.rotation.x = Math.PI / 2
watchEffect(() => plane.position.set(rover.value.x, rover.value.y, rover.value.z))
onBeforeUnmount(() => plane.dispose())
</script>

<template>
  <TresCanvas
    :dpr="[1, 2]"
    power-preference="high-performance"
    :tone-mapping="NoToneMapping"
    :clear-color="sky"
  >
    <SceneAtmosphere :color="sky" :near="HAZE.near" :far="HAZE.far" />
    <FollowCamera
      :target="target"
      :target-key="focusKey"
      :offset="chunks.length > 0 ? undefined : [-3.5, -3.5, 2]"
    />
    <TresHemisphereLight
      :sky-color="HEMISPHERE.sky"
      :ground-color="HEMISPHERE.ground"
      :intensity="0.55 * Math.PI"
    />
    <TresDirectionalLight :position="SUN" :intensity="0.9 * Math.PI" />
    <TerrainChunks
      v-if="chunks.length > 0"
      :chunks="chunks"
      :height-range="heightRange"
      :focus="focus"
      :height-at="heightAt"
      :fog="fog"
    />
    <primitive v-else :object="plane" />
    <RouteLine v-if="route.length > 1" :route="route" :height-at="drawnHeightAt ?? heightAt" />
    <TrailLayer :stops="stops" :keyframes="keyframes" :t="t" :height-at="heightAt" />
    <DeathGhosts
      v-if="deaths.length > 0"
      :deaths="deaths"
      :height-at="heightAt"
      :geometry="geometry"
      :radius-m="deathRadiusM"
      :focused-id="focusedId"
      :ledger="ledger"
    />
    <GoalMarkers v-if="goals.length > 0" :goals="goals" :focused-id="focusedId" />
    <RoverModel
      :frame="frame"
      :geometry="geometry"
      :variant="roverVariant"
      :ledger="ledger"
      @ready="emit('roverReady', $event)"
    />
    <ScenePicker
      v-if="pickables.length > 0"
      :pickables="pickables"
      :rover="rover"
      @hover="(id, client) => emit('hover', id, client)"
      @tap="(id, type, client) => emit('tap', id, type, client)"
    />
  </TresCanvas>
</template>
