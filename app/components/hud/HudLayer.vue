<script setup lang="ts">
/**
 * The layer of HUD widgets over the scene. It lets pointers through to the scene everywhere but
 * on its widgets: the default slot holds absolutely placed panels (which take pointers
 * themselves), `top` and `bottom` stack widgets centred along those edges, above the panels.
 */
</script>

<template>
  <div data-test="hud" class="pointer-events-none absolute inset-0 overflow-hidden">
    <slot />
    <div
      class="absolute inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-2 *:pointer-events-auto"
    >
      <slot name="top" />
    </div>
    <div
      class="absolute inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-2 *:pointer-events-auto"
    >
      <slot name="bottom" />
    </div>
  </div>
</template>
