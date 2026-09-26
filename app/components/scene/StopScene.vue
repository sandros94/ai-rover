<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import { GridHelper, NoToneMapping, Vector3 } from 'three'
import type { GridRect } from '#shared/utils/client'
import type { ChunkFog, TerrainChunk } from '#shared/utils/client/scene'
import {
  FOG_FILL,
  framePlacement,
  HILLSHADE_LIGHT,
  LOD_FAR_M,
  rgbHex,
} from '#shared/utils/client/scene'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { ResolvedRoverGeometry } from '#shared/utils/rover'
import type { RoverVariant } from '~/composables/useRoverVariant'
import DeathGhosts from './DeathGhosts.vue'
import FollowCamera from './FollowCamera.vue'
import RouteLine from './RouteLine.vue'
import RoverModel from './RoverModel.vue'
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
    deaths?: { x: number; y: number; z: number; headingRad: number }[]
    /** Radius of the red circle around each death, metres. */
    deathRadiusM?: number
    /** The stop disk's fog over `chunks`; without it every chunk shows its true ground. */
    fog?: ChunkFog & { rects?: GridRect[] }
    /** The rover to draw; by default the JPL model, the procedural one while it loads or if it fails. */
    roverVariant?: RoverVariant
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
  },
)

const emit = defineEmits<{
  /** The rover drawn changed: the procedural one, or a JPL model once loaded. */
  roverReady: [info: { variant: RoverVariant; triangles: number; loadMs: number }]
}>()

const rover = computed(() => framePlacement(props.frame).position)
const focus = computed(() => ({ x: rover.value.x, y: rover.value.y }))
/** Camera target: the body's middle rather than its ground-level origin. */
const target = computed(() => ({ ...rover.value, z: rover.value.z + 1 }))

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
    <FollowCamera :target="target" :offset="chunks.length > 0 ? undefined : [-3.5, -3.5, 2]" />
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
    />
    <RoverModel
      :frame="frame"
      :geometry="geometry"
      :variant="roverVariant"
      @ready="emit('roverReady', $event)"
    />
  </TresCanvas>
</template>
