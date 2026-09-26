<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useRuntimeConfig } from '#imports'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import type { RoverVariant } from '~/composables/useRoverVariant'

const props = defineProps<{
  /** The 19 keyframe values at the scrub time. */
  frame: Float32Array
}>()

// Lazy: three.js loads with the scene, never with the playground shell.
const StopScene = defineAsyncComponent(
  () =>
    // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
    import('~/components/scene/StopScene.vue'),
)

const VARIANTS: { value: RoverVariant; label: string }[] = [
  { value: 'procedural', label: 'Procedural' },
  { value: 'model', label: 'Model' },
]

const variant = ref<RoverVariant>('model')
const shown = ref<{ variant: RoverVariant; triangles: number; loadMs: number }>()
/** The model file's size, from the same load the scene made (the loader caches it). */
const bytes = ref<number>()
const baseURL = useRuntimeConfig().app.baseURL

async function onReady(info: { variant: RoverVariant; triangles: number; loadMs: number }) {
  shown.value = info
  if (info.variant !== 'model' || bytes.value) return
  // Lazy, like the scene: the loader brings three.js.
  const { loadRoverModel } = await import('~/utils/rover-model')
  bytes.value = (await loadRoverModel(baseURL)).bytes
}

/** The frame moved to the origin, attitude, spins and suspension kept: the rover alone on a plane. */
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
          v-for="option in VARIANTS"
          :key="option.value"
          :variant="option.value === variant ? 'solid' : 'outline'"
          color="neutral"
          @click="variant = option.value"
        >
          {{ option.label }}
        </UButton>
      </UFieldGroup>
      <p class="text-sm text-muted" data-testid="rover-model-stats">
        <template v-if="shown && shown.variant === variant">
          {{ shown.triangles.toLocaleString('en') }} triangles
          <template v-if="shown.variant === 'model'">
            <template v-if="bytes">· {{ (bytes / 1e6).toFixed(2) }} MB</template>
            · loaded in {{ Math.round(shown.loadMs) }} ms
          </template>
        </template>
        <template v-else>Loading…</template>
      </p>
    </div>
    <div class="h-[60vh] min-h-72 overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <StopScene :frame="atOrigin" :rover-variant="variant" @rover-ready="onReady" />
      </ClientOnly>
    </div>
    <p class="text-xs text-muted">
      Rover model: NASA/JPL-Caltech (m2020-urdf-models). The procedural rover shows while the model
      loads.
    </p>
  </div>
</template>
