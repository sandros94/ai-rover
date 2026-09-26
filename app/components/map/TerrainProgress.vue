<script setup lang="ts">
/** The stop's terrain arriving: chunks loaded out of the disk's, or why it failed. */
defineProps<{ ready: boolean; loaded: number; total: number; error: unknown }>()
</script>

<template>
  <div
    v-if="!ready"
    class="absolute inset-x-4 bottom-4 space-y-1 rounded-md bg-(--ui-bg)/80 p-2 text-xs"
  >
    <p v-if="error" class="text-error">The terrain did not load: {{ String(error) }}</p>
    <template v-else>
      <p class="text-muted">Loading terrain {{ loaded }} / {{ total || '…' }}</p>
      <UProgress :model-value="total ? (100 * loaded) / total : null" size="xs" />
    </template>
  </div>
</template>
