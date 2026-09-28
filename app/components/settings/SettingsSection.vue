<script setup lang="ts">
/** One titled section of the settings page. */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <section class="space-y-3">
    <header>
      <h2 class="text-sm font-semibold">{{ title }}</h2>
      <p v-if="description" class="text-sm text-muted">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>
