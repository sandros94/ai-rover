<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref } from 'vue'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import type { RoverLook } from '#shared/utils/client/scene/rover-looks'
import type { LoadedRoverModel, RoverModelFile } from '~/utils/rover-model'

const props = defineProps<{
  /** The 23 keyframe values at the scrub time. */
  frame: Float32Array
}>()

// Lazy: three.js loads with the scene, never with the playground shell.
const RoverModelsScene = defineAsyncComponent(() => import('./RoverModelsScene.vue'))

const LOOKS: { value: RoverLook; label: string }[] = [
  { value: 'standin', label: 'Stand-in' },
  { value: 'ghost', label: 'Ghost' },
]
const look = ref<RoverLook>('standin')

const MODELS: { file: RoverModelFile; label: string }[] = [
  { file: 'full', label: 'Full' },
  { file: 'low-poly', label: 'Low-poly' },
]
const loaded = reactive<Partial<Record<RoverModelFile, LoadedRoverModel | Error>>>({})
const stats = (file: RoverModelFile): string => {
  const result = loaded[file]
  if (!result) return 'loading…'
  if (result instanceof Error) return result.message
  return `${result.triangles.toLocaleString('en')} triangles · ${(result.bytes / 1e6).toFixed(2)} MB · loaded in ${Math.round(result.loadMs)} ms`
}

/** The frame moved to the origin, attitude, spins and suspension kept: the rovers alone on a plane. */
const atOrigin = computed(() => {
  const frame = props.frame.slice()
  for (const name of ['x', 'y', 'z'] as const) frame[KEYFRAME_FIELDS.indexOf(name)] = 0
  return frame
})
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-3">
      <UFieldGroup>
        <UButton
          v-for="option in LOOKS"
          :key="option.value"
          :variant="option.value === look ? 'solid' : 'outline'"
          color="neutral"
          @click="look = option.value"
        >
          {{ option.label }}
        </UButton>
      </UFieldGroup>
      <p
        v-for="model in MODELS"
        :key="model.file"
        class="text-sm text-muted"
        data-testid="rover-model-stats"
      >
        <span class="font-medium text-default">{{ model.label }}</span> · {{ stats(model.file) }}
      </p>
    </div>
    <div class="h-[60vh] min-h-72 overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <RoverModelsScene
          :frame="atOrigin"
          :look="look"
          @loaded="(file, result) => (loaded[file] = result)"
        />
      </ClientOnly>
    </div>
    <p class="text-xs text-muted">
      Rover model: NASA/JPL-Caltech (m2020-urdf-models). The full model on the left, the low-poly
      one on the right in the chosen look.
    </p>
  </div>
</template>
