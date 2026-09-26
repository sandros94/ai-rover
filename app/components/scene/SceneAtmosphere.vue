<script setup lang="ts">
import { useTres } from '@tresjs/core'
import { Color, Fog } from 'three'

const props = defineProps<{
  /** Sky and distance fog colour, `#rrggbb`: the colour unseen ground is drawn in. */
  color: string
  /** Distances, metres from the camera, where the fog starts and where it hides everything. */
  near: number
  far: number
}>()

const { scene } = useTres()
const fog = new Fog(props.color, props.near, props.far)
const background = new Color(props.color)

watchEffect(() => {
  fog.color.set(props.color)
  fog.near = props.near
  fog.far = props.far
  background.set(props.color)
  scene.value.fog = fog
  scene.value.background = background
})

onBeforeUnmount(() => {
  if (scene.value.fog === fog) scene.value.fog = null
  if (scene.value.background === background) scene.value.background = null
})
</script>

<template>
  <slot />
</template>
