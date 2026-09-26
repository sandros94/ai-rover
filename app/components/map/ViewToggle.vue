<script setup lang="ts">
import type { MapViewMode } from '~/composables/useMapView'

const view = defineModel<MapViewMode>({ required: true })

const OPTIONS = [
  { value: '2d', label: '2D', icon: 'i-lucide-map' },
  { value: '3d', label: '3D', icon: 'i-lucide-box' },
] as const
</script>

<template>
  <UFieldGroup size="sm" aria-label="Map view">
    <UButton
      v-for="option in OPTIONS"
      :key="option.value"
      :data-test="`view-${option.value}`"
      :icon="option.icon"
      color="neutral"
      :variant="view === option.value ? 'solid' : 'outline'"
      :aria-pressed="view === option.value"
      @click="view = option.value"
    >
      {{ option.label }}
    </UButton>
  </UFieldGroup>
</template>
