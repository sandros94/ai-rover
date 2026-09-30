<script lang="ts">
import StopStage from './StopStage.vue'

/** Everything `StopStage` draws, but the view. */
export type StageProps = Omit<InstanceType<typeof StopStage>['$props'], 'view' | 'onUpdate:view'>
</script>

<script setup lang="ts">
import type { MapViewMode } from '~/composables/useMapView'

/**
 * A stage whose props are read here, where it is drawn: they change every animation frame while
 * a drive plays, and reading them in a page would redraw the page, its panels and its slots.
 * Listeners (`pick`, `hover`) pass through to the stage. `progress: false` leaves the terrain's
 * loading progress to another stage of the same stop.
 */
withDefaults(defineProps<{ stage: () => StageProps; view: MapViewMode; progress?: boolean }>(), {
  progress: true,
})
</script>

<template>
  <StopStage v-bind="stage()" :view="view" :progress="progress" />
</template>
