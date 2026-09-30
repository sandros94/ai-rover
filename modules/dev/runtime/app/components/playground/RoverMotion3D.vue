<script setup lang="ts">
// TODO(dev-only): the rover model's scripted motions; lives in the dev module only.
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Object3D } from 'three'
import { useRoute, useRuntimeConfig } from '#imports'
import { formatLmst } from '#shared/utils/client/instruments'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import { MODEL_LOOKS, useModelLook } from '../../playground/model-look'
import type { ModelLook } from '../../playground/model-look'
import type { MotionDemo, MotionState } from '../../playground/rover-motion'
import { MOTION_DEMOS, motionAt } from '../../playground/rover-motion'

// Lazy: three.js loads with the scene, never with the playground shell.
const RoverJointsScene = defineAsyncComponent(() => import('./RoverJointsScene.vue'))

const baseURL = useRuntimeConfig().app.baseURL

/** The model, for its materials; the scene draws its own copy with the same ones. */
const model = shallowRef<Object3D>()
const failed = ref<string>()
void import('~/utils/rover-model')
  .then(({ loadRoverModel }) => loadRoverModel(baseURL))
  .then((loaded) => (model.value = loaded.scene))
  .catch((error: Error) => (failed.value = error.message))
const look = ref<ModelLook>('solid')
useModelLook(model, look)

/** Opened at `?demo=` and `?t=` seconds when given: repeatable screenshots mid-motion. */
const route = useRoute()
const demo = ref<MotionDemo>(
  MOTION_DEMOS.find((d) => d.id === route.query.demo)?.id ?? 'point-turn',
)
const tabs = MOTION_DEMOS.map(({ id, title }) => ({ label: title, value: id }))
const duration = computed(() => MOTION_DEMOS.find((d) => d.id === demo.value)!.durationS)
/** Seconds into the demo, and sol seconds per wall-clock second while playing. */
const t = ref(Math.max(0, Number(route.query.t) || 0))
const SPEEDS = [1, 10]
const speed = ref(1)
const playing = ref(false)
const state = computed(() => motionAt(demo.value, t.value))

watch(demo, () => {
  playing.value = false
  t.value = 0
})

let raf = 0
let last = 0
function tick(now: number): void {
  t.value = Math.min(duration.value, t.value + ((now - last) / 1000) * speed.value)
  last = now
  if (t.value >= duration.value) playing.value = false
  else raf = requestAnimationFrame(tick)
}
watch(playing, (on) => {
  cancelAnimationFrame(raf)
  if (!on) return
  if (t.value >= duration.value) t.value = 0
  last = performance.now()
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))

/** The sol clock as local mean solar time, for the twilight demo. */
const lmst = computed(() => {
  const s = Math.floor(state.value.solFraction * 86_400)
  return formatLmst({
    hours: Math.floor(s / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  })
})

const DEG = 180 / Math.PI
/**
 * What the demos move, as the readout lists it: the corner steering angles as the frame records
 * them (counter-clockwise from above), and the arm joints.
 */
const READOUT: { label: string; read: (state: MotionState) => number }[] = [
  ...(['steerFL', 'steerFR', 'steerRL', 'steerRR'] as const).map((name) => ({
    label: name,
    read: (state: MotionState) => state.frame[KEYFRAME_FIELDS.indexOf(name)]!,
  })),
  ...['arm_1', 'arm_2', 'arm_3', 'arm_4', 'arm_5'].map((node) => ({
    label: node,
    read: (state: MotionState) => state.joints[node] ?? 0,
  })),
]
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[1fr_22rem]">
    <div class="h-[70vh] min-h-72 overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <RoverJointsScene
          :frame="state.frame"
          :joints="state.joints"
          :height-at="() => 0"
          :sol-fraction="state.solFraction"
          :lamp="state.lamp"
        />
      </ClientOnly>
    </div>
    <div class="space-y-3">
      <UTabs v-model="demo" :items="tabs" :content="false" data-testid="motion-demos" />
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
          :aria-label="playing ? 'Pause' : 'Play'"
          @click="playing = !playing"
        />
        <UFieldGroup>
          <UButton
            v-for="rate in SPEEDS"
            :key="rate"
            :variant="rate === speed ? 'solid' : 'outline'"
            color="neutral"
            @click="speed = rate"
          >
            {{ rate }}×
          </UButton>
        </UFieldGroup>
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
      <USlider v-model="t" :min="0" :max="duration" :step="0.1" aria-label="Time" />
      <p class="font-mono text-sm">
        <span class="readout min-w-[7ch]">{{ t.toFixed(1) }}</span> / {{ duration.toFixed(1) }} s
        <template v-if="demo === 'dusk-dawn'">
          · {{ lmst }} LMST · lamp {{ (state.lamp * 100).toFixed(0) }} %
        </template>
      </p>
      <p v-if="failed" class="text-sm text-error">{{ failed }}</p>
      <ul class="grid grid-cols-2 gap-x-4 font-mono text-xs">
        <li v-for="{ label, read } in READOUT" :key="label" class="flex justify-between">
          <span>{{ label }}</span>
          <span class="tabular-nums">{{ (read(state) * DEG).toFixed(1) }}°</span>
        </li>
      </ul>
      <p class="text-xs text-muted">
        Scripted motions on the drive's own wheel angles, steering, turn and drive limits. Point
        turn: the corner wheels steer into the toe-in stance, the body turns a quarter turn with
        each side spinning the other way, then they steer back. Arc: the corners steer to
        double-Ackermann angles about a centre 4 m to the left and the rover drives 3.6 m at the
        cruise speed, each wheel spinning at its own radius. Dusk and dawn: the sol clock from a
        minute before sunset until the lamp is full, then from before sunrise until the arm has
        stowed.
      </p>
    </div>
  </div>
</template>
