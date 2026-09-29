<script lang="ts">
import { installAgXLook } from '#shared/utils/client/scene/tonemap'

if (import.meta.client) installAgXLook()
</script>

<script setup lang="ts">
// TODO(dev-only): the two rover models side by side; lives in the dev module only.
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { TresCanvas } from '@tresjs/core'
import type { Object3D, Texture } from 'three'
import {
  CustomToneMapping,
  Group,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three'
import { useRuntimeConfig } from '#imports'
import { framePlacement, skyLighting, sunPosition } from '#shared/utils/client/scene'
import type { RoverLook } from '#shared/utils/client/scene/rover-looks'
import { applyRoverLook } from '#shared/utils/client/scene/rover-looks'
import type { LoadedRoverModel, RoverModelFile } from '~/utils/rover-model'
import { applyEnvironment, loadRoverModel } from '~/utils/rover-model'
import type { PosableRover } from '~/utils/rover-pose'
import { posableRover, poseRover } from '~/utils/rover-pose'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import FollowCamera from '~/components/scene/FollowCamera.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneEnvironment from '~/components/scene/SceneEnvironment.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSky from '~/components/scene/SceneSky.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSun from '~/components/scene/SceneSun.vue'

const props = defineProps<{
  /** The rover's keyframe; both models take its attitude, suspension and spins. */
  frame: Float32Array
  /** The look the low-poly model is drawn in. */
  look: RoverLook
}>()

const emit = defineEmits<{
  /** A model is in, or failed. */
  loaded: [file: RoverModelFile, result: LoadedRoverModel | Error]
}>()

const baseURL = useRuntimeConfig().app.baseURL
const sun = computed(() => sunPosition(0.4))
const lighting = computed(() => skyLighting(sun.value.elevationDeg))
const environment = shallowRef<Texture | null>(null)
const target = computed(() => {
  const { position } = framePlacement(props.frame)
  return { x: position.x, y: position.y, z: position.z + 1 }
})

/** Across the rover's heading, metres: the full model on the left, the low-poly on the right. */
const SIDE_M = 1.8
const models = new Group()
const copies: Partial<Record<RoverModelFile, PosableRover>> = {}

function pose(): void {
  const { position, quaternion } = framePlacement(props.frame)
  for (const [file, rover] of Object.entries(copies)) {
    const object = rover.object.parent!
    object.position.set(position.x, position.y + (file === 'full' ? -SIDE_M : SIDE_M), position.z)
    object.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    poseRover(rover, props.frame)
  }
}

function add(file: RoverModelFile, dress: (object: Object3D) => void): void {
  loadRoverModel(baseURL, file)
    .then((loaded) => {
      const object = loaded.scene.clone()
      dress(object)
      const holder = new Group()
      holder.add(object)
      models.add(holder)
      copies[file] = posableRover(object)
      pose()
      emit('loaded', file, loaded)
    })
    .catch((error: Error) => emit('loaded', file, error))
}

add('full', (object) => {
  object.traverse((child) => (child.castShadow = child.receiveShadow = true))
  applyEnvironment(object, environment.value)
})
add('low-poly', (object) => applyRoverLook(object, props.look))

watch(() => props.frame, pose)
watch(
  () => props.look,
  (look) => {
    const lowPoly = copies['low-poly']
    if (lowPoly) applyRoverLook(lowPoly.object, look)
  },
)
watch(environment, (map) => {
  if (copies.full) applyEnvironment(copies.full.object, map)
})

/** A neutral ground, 12 m by 12 m around the origin. */
const ground = new Mesh(new PlaneGeometry(12, 12), new MeshLambertMaterial({ color: '#9c8f84' }))
ground.receiveShadow = true
onBeforeUnmount(() => {
  ground.geometry.dispose()
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
    <FollowCamera :target="target" :offset="[7, 0.5, 2.5]" />
    <primitive :object="ground" />
    <primitive :object="models" />
  </TresCanvas>
</template>
