<script setup lang="ts">
// TODO(dev-only): the rover model's joints preview; lives in the dev module only.
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue'
import type { Object3D } from 'three'
import { useRuntimeConfig } from '#imports'
import { flatFrame } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { RoverPose } from '#shared/utils/rover'
import { poseOnTerrain } from '#shared/utils/rover'
import type { ModelLook } from '../../playground/model-look'
import { MODEL_LOOKS, useModelLook } from '../../playground/model-look'
import type { JointControl } from '../../playground/rover-joints'
import {
  coupledJoints,
  jointControls,
  SOLVED_JOINTS,
  solvedJoints,
} from '../../playground/rover-joints'

// Lazy: three.js loads with the scene, never with the playground shell.
const RoverJointsScene = defineAsyncComponent(() => import('./RoverJointsScene.vue'))

const baseURL = useRuntimeConfig().app.baseURL
const DEG = 180 / Math.PI

/** The model, for its joint list and its materials; the scene draws its own copy. */
const model = shallowRef<Object3D>()
const failed = ref<string>()
const controls = shallowRef<JointControl[]>([])
const values = reactive<Record<string, number>>({})
void import('~/utils/rover-model')
  .then(({ loadRoverModel }) => loadRoverModel(baseURL))
  .then((loaded) => {
    model.value = loaded.scene
    controls.value = jointControls(loaded.scene)
    for (const control of controls.value) values[control.node] = control.rest
  })
  .catch((error: Error) => (failed.value = error.message))

function set(node: string, degrees: number): void {
  Object.assign(values, coupledJoints(node, degrees / DEG))
}

/**
 * The solver's pose: the rover driving back and forth over a test ground tilted 8° to its left
 * and rippled with 12 cm bumps, the suspension solved where it stands.
 */
const solver = ref(false)
const TILT = Math.tan((8 * Math.PI) / 180)
const bumpy = (x: number, y: number) =>
  y * TILT + 0.12 * Math.sin(1.4 * x + 0.6) * Math.cos(0.8 * y) + 0.05 * Math.sin(3.1 * x - y)
const flat = () => 0
const heightAt = computed(() => (solver.value ? bumpy : flat))
const pose = shallowRef<RoverPose>()
let raf = 0
function drive(now: number): void {
  const x = 3 * Math.sin(now / 6000)
  pose.value = poseOnTerrain(bumpy, { x, y: 0, headingRad: 0 })
  Object.assign(values, solvedJoints(pose.value))
  raf = requestAnimationFrame(drive)
}
watch(solver, (on) => {
  cancelAnimationFrame(raf)
  pose.value = undefined
  if (on) raf = requestAnimationFrame(drive)
  else for (const control of controls.value) values[control.node] = control.rest
})
onBeforeUnmount(() => cancelAnimationFrame(raf))

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)
/** The keyframe the scene draws: the solved placement, or the rover level at the origin. */
const frame = computed(() => {
  const p = pose.value
  if (!p) return flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 })
  const out = new Float32Array(KEYFRAME_STRIDE)
  out[field('x')] = p.position.x
  out[field('y')] = p.position.y
  out[field('z')] = p.position.z
  out[field('qx')] = p.quaternion.x
  out[field('qy')] = p.quaternion.y
  out[field('qz')] = p.quaternion.z
  out[field('qw')] = p.quaternion.w
  return out
})

const look = ref<ModelLook>('solid')
useModelLook(model, look)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[1fr_22rem]">
    <div class="h-[70vh] min-h-72 overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <RoverJointsScene
          :frame="frame"
          :joints="values"
          :height-at="heightAt"
          :sol-fraction="0.4"
        />
      </ClientOnly>
    </div>
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <USwitch v-model="solver" label="Solver pose" />
        <UFieldGroup>
          <UButton
            v-for="option in MODEL_LOOKS"
            :key="option"
            :variant="option === look ? 'solid' : 'outline'"
            color="neutral"
            size="sm"
            @click="look = option"
          >
            {{ option }}
          </UButton>
        </UFieldGroup>
      </div>
      <p v-if="failed" class="text-sm text-error">{{ failed }}</p>
      <p v-else-if="!controls.length" class="text-sm text-muted">Loading the model…</p>
      <ul class="space-y-2">
        <li v-for="control in controls" :key="control.node" data-testid="joint-slider">
          <div class="flex justify-between text-xs">
            <span>
              <span class="font-medium">{{ control.node }}</span>
              <span class="text-muted"> · {{ control.joint }}</span>
            </span>
            <span class="tabular-nums">{{ ((values[control.node] ?? 0) * DEG).toFixed(1) }}°</span>
          </div>
          <USlider
            :model-value="(values[control.node] ?? 0) * DEG"
            :min="control.min * DEG"
            :max="control.max * DEG"
            :step="0.1"
            :disabled="solver && SOLVED_JOINTS.has(control.node)"
            :aria-label="`${control.node} (${control.joint})`"
            @update:model-value="(v?: number) => v !== undefined && set(control.node, v)"
          />
        </li>
      </ul>
      <p class="text-xs text-muted">
        Rover model: NASA/JPL-Caltech. Sliders span each joint's URDF limits, or for the unlimited
        mobility joints the solver's suspension warnings, a quarter turn of steering and a full
        wheel turn. The rockers and the differential bar move together, as the linkage makes them.
      </p>
    </div>
  </div>
</template>
