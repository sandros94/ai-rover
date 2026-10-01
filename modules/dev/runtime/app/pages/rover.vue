<script lang="ts">
import { installAgXLook } from '#shared/utils/client/scene/tonemap'

if (import.meta.client) installAgXLook()
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { TresCanvas } from '@tresjs/core'
import type { Object3D, Texture } from 'three'
import {
  Box3,
  CustomToneMapping,
  Group,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three'
import { useRoute, useRuntimeConfig } from '#imports'
import { flatFrame, skyLighting, sunPosition } from '#shared/utils/client/scene'
import { applyEnvironment, loadRoverModel } from '~/utils/rover-model'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverModel from '~/components/scene/RoverModel.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneEnvironment from '~/components/scene/SceneEnvironment.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSky from '~/components/scene/SceneSky.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SceneSun from '~/components/scene/SceneSun.vue'
import FreeCamera from '../components/rover-view/FreeCamera.vue'

/**
 * The rover on its own, at rest at the origin facing +x (x forward, y left, z up), under a free
 * camera: for looking at the model from any side, and for repeatable captures. The query sets
 * the opening view, and the readout gives the current one as a query to paste back:
 *
 * - `cam`, `at`: camera position and the point it looks at, `x,y,z` metres.
 * - `ortho=1` with `size`: no perspective, `size` metres from the bottom of the view to the top.
 *   Otherwise perspective, `fov` degrees tall.
 * - `sol`: time of the sol for the light; `ground=0` hides the ground; `hud=0` hides the readout.
 * - `part`: one node of the full model alone, by name (as `wheel_lm`), centred on the origin in
 *   the model's own orientation; no ground is drawn under it.
 *
 * `data-rover-ready` is set on the root element once the full model is drawn and has settled.
 */
const SETTLE_MS = 1500

const route = useRoute()
const text = (name: string) => (typeof route.query[name] === 'string' ? route.query[name] : '')
function number(name: string, fallback: number): number {
  const value = Number(text(name))
  return text(name) !== '' && Number.isFinite(value) ? value : fallback
}
function point(name: string, fallback: [number, number, number]) {
  const parts = text(name).split(',').map(Number)
  const [x, y, z] = parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback
  return { x: x!, y: y!, z: z! }
}

const orthographic = text('ortho') === '1'
const opening = {
  position: point('cam', [4, 5, 2.5]),
  target: point('at', [0, 0, 1]),
  fovDeg: number('fov', 50),
  sizeM: number('size', 3.5),
}
const hud = text('hud') !== '0'
const part = text('part')
const showGround = text('ground') !== '0' && !part

const sun = computed(() => sunPosition(number('sol', 0.4)))
const lighting = computed(() => skyLighting(sun.value.elevationDeg))
const environment = shallowRef<Texture | null>(null)
const frame = flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 })

/** A neutral ground, 20 m by 20 m around the rover. */
const ground = new Mesh(new PlaneGeometry(20, 20), new MeshLambertMaterial({ color: '#9c8f84' }))
ground.receiveShadow = true
onBeforeUnmount(() => {
  ground.geometry.dispose()
  ground.material.dispose()
})

const f = (n: number) => +n.toFixed(3)
const readout = shallowRef('')
function onPose(pose: {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  fovDeg: number
  sizeM: number
}): void {
  const { position: p, target: t } = pose
  const field = orthographic ? `ortho=1&size=${f(pose.sizeM)}` : `fov=${f(pose.fovDeg)}`
  readout.value = `cam=${f(p.x)},${f(p.y)},${f(p.z)}&at=${f(t.x)},${f(t.y)},${f(t.z)}&${field}`
}

/** The `part` alone: a copy of its node, turned as in the model and centred on the origin. */
const isolated = new Group()
const partError = shallowRef('')
onMounted(async () => {
  if (!part) return
  try {
    const { scene } = await loadRoverModel(useRuntimeConfig().app.baseURL, 'full')
    scene.updateMatrixWorld(true)
    const node = scene.getObjectByName(part)
    if (!node) throw new Error(`The model has no node named "${part}".`)
    const copy = node.clone()
    node.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
    const holder = new Group()
    holder.add(copy)
    holder.updateMatrixWorld(true)
    const centre = new Box3().setFromObject(holder).getCenter(copy.position.clone())
    copy.position.sub(centre)
    copy.traverse((child: Object3D) => (child.castShadow = child.receiveShadow = true))
    applyEnvironment(copy, environment.value)
    isolated.add(copy)
    onStatus('full')
  } catch (error) {
    partError.value = error instanceof Error ? error.message : String(error)
  }
})
watch(environment, (map) => {
  for (const child of isolated.children) applyEnvironment(child, map)
})

function onStatus(status: string): void {
  if (status !== 'full') return
  setTimeout(() => {
    document.documentElement.dataset.roverReady = ''
  }, SETTLE_MS)
}
</script>

<template>
  <div class="fixed inset-0">
    <ClientOnly>
      <TresCanvas
        :dpr="[1, 2]"
        :tone-mapping="CustomToneMapping"
        :output-color-space="SRGBColorSpace"
        shadows
        :shadow-map-type="PCFShadowMap"
        :clear-color="lighting.horizon"
      >
        <FreeCamera v-bind="opening" :orthographic="orthographic" @pose="onPose" />
        <SceneSky :direction="sun.direction" :lighting="lighting" />
        <SceneEnvironment
          :direction="sun.direction"
          :lighting="lighting"
          @change="environment = $event"
        />
        <SceneSun :direction="sun.direction" :lighting="lighting" :target="{ x: 0, y: 0, z: 1 }" />
        <primitive v-if="showGround" :object="ground" />
        <primitive v-if="part" :object="isolated" />
        <RoverModel v-else :frame="frame" :environment="environment" @status="onStatus" />
      </TresCanvas>
    </ClientOnly>
    <p v-if="partError" class="absolute top-10 left-2 text-sm text-error">{{ partError }}</p>
    <code
      v-if="hud"
      class="absolute top-2 left-2 rounded bg-default/80 px-2 py-1 font-mono text-xs select-all"
      data-test="camera-query"
      >?{{ readout }}</code
    >
  </div>
</template>
