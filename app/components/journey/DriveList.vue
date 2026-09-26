<script setup lang="ts">
import type { DriveJson } from '~/composables/useJourney'
import DriveRow from './DriveRow.vue'

/** Settled drives, each leading to its replay. */
defineProps<{ drives: DriveJson[] }>()
</script>

<template>
  <p v-if="drives.length === 0" data-test="drives-empty" class="text-sm text-muted">
    No drive has ended yet.
  </p>
  <ul v-else class="divide-y divide-(--ui-border) rounded-lg border border-default">
    <li v-for="drive in drives" :key="drive.id" data-test="drive">
      <NuxtLink
        :to="`/drives/${drive.id}`"
        class="block px-3 py-2 transition-colors hover:bg-(--ui-bg-elevated)"
      >
        <DriveRow :drive="drive" />
      </NuxtLink>
    </li>
  </ul>
</template>
