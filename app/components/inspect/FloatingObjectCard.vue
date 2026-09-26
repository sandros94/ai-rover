<script setup lang="ts">
import type { MapObject } from '#shared/utils/client'
import ObjectCard from './ObjectCard.vue'

/**
 * An object's card beside the pointer, over everything on the page (the HUD's panels included):
 * below and right of `client`, flipped to the other side near the viewport's right or bottom edge.
 */
const props = defineProps<{
  object: MapObject
  /** The pointer, client pixels. */
  client: { x: number; y: number }
}>()

/** Gap between the pointer and the card, and room kept for the card before flipping, pixels. */
const GAP_PX = 14
const ROOM = { width: 272, height: 140 }

const style = computed(() => {
  const { x, y } = props.client
  const width = typeof window === 'undefined' ? Infinity : window.innerWidth
  const height = typeof window === 'undefined' ? Infinity : window.innerHeight
  return {
    ...(x + GAP_PX + ROOM.width > width
      ? { right: `${width - x + GAP_PX}px` }
      : { left: `${x + GAP_PX}px` }),
    ...(y + GAP_PX + ROOM.height > height
      ? { bottom: `${height - y + GAP_PX}px` }
      : { top: `${y + GAP_PX}px` }),
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed z-[60]" :style="style">
      <ObjectCard :object="object" />
    </div>
  </Teleport>
</template>
