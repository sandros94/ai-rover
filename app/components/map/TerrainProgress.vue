<script setup lang="ts">
import type { StageWait } from '~/utils/stage-wait'
import { stageWaitLabel } from '~/utils/stage-wait'

/** What the stop's stage still waits for, the terrain's chunks counted; or why they failed. */
defineProps<{ waiting: StageWait | undefined; error: unknown }>()
</script>

<template>
  <div
    v-if="waiting"
    data-test="terrain-progress"
    :data-waiting="waiting.what"
    class="absolute inset-x-4 bottom-4 space-y-1 rounded-md bg-(--ui-bg)/80 p-2 text-xs"
  >
    <p v-if="error" class="text-error">The terrain did not load: {{ String(error) }}</p>
    <template v-else>
      <p class="text-muted">{{ stageWaitLabel(waiting) }}</p>
      <UProgress
        :model-value="
          waiting.what === 'terrain' && waiting.total
            ? (100 * waiting.loaded) / waiting.total
            : null
        "
        size="xs"
      />
    </template>
  </div>
</template>
