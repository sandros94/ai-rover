<script setup lang="ts">
/**
 * Panels stacked in a sheet from the bottom, for viewports too narrow to float them: one slot per
 * id in `ids`, in that order. It leaves the scene above it live to touch.
 */
defineProps<{
  /** Names the sheet for tests and styling: `instruments` or `vote`. */
  sheet: string
  title: string
  ids: readonly string[]
}>()
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <UDrawer
    v-model:open="open"
    :title="title"
    :overlay="false"
    :modal="false"
    close
    :ui="{ content: 'max-h-[70dvh]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <div data-test="phone-sheet" :data-sheet="sheet" class="space-y-3">
        <template v-for="id in ids" :key="id">
          <slot :name="id" />
        </template>
      </div>
    </template>
  </UDrawer>
</template>
