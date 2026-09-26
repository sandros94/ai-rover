<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'

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

/** The frame moved to the origin, attitude, spins and suspension kept: the rover alone on a plane. */
const atOrigin = computed(() => {
  const frame = props.frame.slice()
  for (const name of ['x', 'y', 'z'] as const) frame[KEYFRAME_FIELDS.indexOf(name)] = 0
  return frame
})
</script>

<template>
  <div class="h-[60vh] min-h-72 overflow-hidden rounded-md border border-default">
    <ClientOnly>
      <StopScene :frame="atOrigin" />
    </ClientOnly>
  </div>
</template>
