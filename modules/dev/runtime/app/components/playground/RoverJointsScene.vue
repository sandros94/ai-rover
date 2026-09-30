<script lang="ts">
import { installAgXLook } from '#shared/utils/client/scene/tonemap'

if (import.meta.client) installAgXLook()
</script>

<script setup lang="ts">
// TODO(dev-only): the joints preview's scene; lives in the dev module only.
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { TresCanvas } from '@tresjs/core'
import type { Texture } from 'three'
import {
  CustomToneMapping,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three'
import { framePlacement, skyLighting, sunPosition } from '#shared/utils/client/scene'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import FollowCamera from '~/components/scene/FollowCamera.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverModel from '~/components/scene/RoverModel.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneEnvironment from '~/components/scene/SceneEnvironment.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSky from '~/components/scene/SceneSky.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSun from '~/components/scene/SceneSun.vue'

const props = withDefaults(
  defineProps<{
    /** The rover's keyframe: its placement, suspension and spins. */
    frame: Float32Array
    /** Joint values by model node name, over the keyframe's. */
    joints: Record<string, number>
    /** The ground under the rover, world metres. */
    heightAt: (x: number, y: number) => number
    /** Time of the sol, 0 and 1 midnight. */
    solFraction: number
    /** The arm turret's lamp, 0 off to 1 full. */
    lamp?: number
  }>(),
  { lamp: 0 },
)

const sun = computed(() => sunPosition(props.solFraction))
const lighting = computed(() => skyLighting(sun.value.elevationDeg))
const environment = shallowRef<Texture | null>(null)
const rover = computed(() => framePlacement(props.frame).position)
const target = computed(() => ({ x: rover.value.x, y: rover.value.y, z: rover.value.z + 1 }))

/** A neutral ground, 16 m by 10 m around the origin, at 5 cm resolution. */
const geometry = new PlaneGeometry(16, 10, 320, 200)
const ground = new Mesh(geometry, new MeshLambertMaterial({ color: '#9c8f84' }))
ground.receiveShadow = true
watch(
  () => props.heightAt,
  (heightAt) => {
    const position = geometry.attributes.position!
    for (let i = 0; i < position.count; i++) {
      position.setZ(i, heightAt(position.getX(i), position.getY(i)))
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  geometry.dispose()
  ground.material.dispose()
})
</script>

<template>
  <TresCanvas
    :dpr="[1, 2]"
    :tone-mapping="CustomToneMapping"
    :output-color-space="SRGBColorSpace"
    shadows
    :shadow-map-type="PCFShadowMap"
    :clear-color="lighting.horizon"
  >
    <SceneSky :direction="sun.direction" :lighting="lighting" />
    <SceneEnvironment
      :direction="sun.direction"
      :lighting="lighting"
      @change="environment = $event"
    />
    <SceneSun :direction="sun.direction" :lighting="lighting" :target="target" />
    <FollowCamera :target="target" :offset="[3.5, 4, 1.2]" />
    <primitive :object="ground" />
    <RoverModel :frame="frame" :joints="joints" :environment="environment" :lamp="lamp" />
  </TresCanvas>
</template>
