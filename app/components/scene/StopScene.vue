<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import { GridHelper, NoToneMapping, Vector3 } from 'three'
import type { DiskLayout, TerrainChunk } from '#shared/utils/client/scene'
import { framePlacement, HILLSHADE_LIGHT, SCENE_COLORS } from '#shared/utils/client/scene'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { ResolvedRoverGeometry } from '#shared/utils/rover'
import DeathGhosts from './DeathGhosts.vue'
import FollowCamera from './FollowCamera.vue'
import RouteLine from './RouteLine.vue'
import RoverModel from './RoverModel.vue'
import TerrainChunks from './TerrainChunks.vue'
import TrailLayer from './TrailLayer.vue'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values at the playback time. */
    frame: Float32Array
    geometry?: ResolvedRoverGeometry
    /** The stop disk's chunks; without any, the rover stands on a flat grid at its own height. */
    chunks?: { chunk: TerrainChunk; seen?: Uint8Array }[]
    /** Height span of the disk for the colour ramp; required with `chunks`. */
    heightRange?: { min: number; max: number }
    heightAt?: (x: number, y: number) => number | undefined
    stops?: { x: number; y: number }[]
    keyframes?: KeyframeBlock
    /** Sim seconds, for the path driven so far. */
    t?: number
    route?: { x: number; y: number }[]
    deaths?: { x: number; y: number; z: number; headingRad: number }[]
    /** Radius of the red circle around each death, metres. */
    deathRadiusM?: number
    /** What the playing drive has seen so far, as disk-grid indices laid out by `layout`. */
    reveals?: readonly { vertices: ArrayLike<number> }[]
    layout?: DiskLayout
  }>(),
  {
    geometry: undefined,
    chunks: () => [],
    heightRange: () => ({ min: 0, max: 1 }),
    heightAt: undefined,
    stops: () => [],
    keyframes: undefined,
    t: 0,
    route: () => [],
    deaths: () => [],
    deathRadiusM: undefined,
    reveals: () => [],
    layout: undefined,
  },
)

const rover = computed(() => framePlacement(props.frame).position)
const focus = computed(() => ({ x: rover.value.x, y: rover.value.y }))
/** Camera target: the body's middle rather than its ground-level origin. */
const target = computed(() => ({ ...rover.value, z: rover.value.z + 1 }))

/**
 * Lighting for the rover only (the terrain's shading is baked): the hillshade's sun from the
 * north-west and an ambient floor. A directional light shines from its position towards its
 * target at the world origin, so the position is the direction alone. three.js divides Lambert
 * light by π, hence the factor on the intensities.
 */
const SUN = new Vector3(HILLSHADE_LIGHT.x, HILLSHADE_LIGHT.y, HILLSHADE_LIGHT.z)
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
    :clear-color="SCENE_COLORS.sky"
  >
    <FollowCamera :target="target" :offset="chunks.length > 0 ? undefined : [-3.5, -3.5, 2]" />
    <TresAmbientLight :intensity="0.35 * Math.PI" />
    <TresDirectionalLight :position="SUN" :intensity="0.9 * Math.PI" />
    <TerrainChunks
      v-if="chunks.length > 0"
      :chunks="chunks"
      :height-range="heightRange"
      :focus="focus"
      :height-at="heightAt"
      :reveals="reveals"
      :layout="layout"
    />
    <primitive v-else :object="plane" />
    <RouteLine v-if="route.length > 1" :route="route" :height-at="heightAt" />
    <TrailLayer :stops="stops" :keyframes="keyframes" :t="t" :height-at="heightAt" />
    <DeathGhosts
      v-if="deaths.length > 0"
      :deaths="deaths"
      :height-at="heightAt"
      :geometry="geometry"
      :radius-m="deathRadiusM"
    />
    <RoverModel :frame="frame" :geometry="geometry" />
  </TresCanvas>
</template>
