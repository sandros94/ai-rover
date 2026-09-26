<script setup lang="ts">
/**
 * "Rover not moving" for the drive in progress: the flags that count now against the quorum
 * that fails it (with no progress over the window), and the signed-in user's own flag.
 */
const props = defineProps<{
  segmentId: string
  flags: { count: number; quorum: number }
  signedIn: boolean
}>()
/** A flag changed the mission state. */
const emit = defineEmits<{ changed: [] }>()

const mine = ref(false)
const sending = ref(false)

async function loadMine(): Promise<void> {
  if (!props.signedIn) {
    mine.value = false
    return
  }
  const answer = await $fetch<{ mine: boolean }>(
    `/api/mission/segments/${props.segmentId}/flag`,
  ).catch(() => null)
  mine.value = answer?.mine ?? false
}
watch(() => [props.segmentId, props.signedIn], loadMine, { immediate: true })

async function flag(): Promise<void> {
  sending.value = true
  try {
    await $fetch(`/api/mission/segments/${props.segmentId}/flag`, { method: 'PUT' })
    mine.value = true
    emit('changed')
  } catch {
    // The drive may have ended meanwhile; the next state poll shows where it stands.
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-2 text-xs">
    <UButton
      v-if="signedIn"
      data-test="flag"
      size="xs"
      color="warning"
      :variant="mine ? 'soft' : 'outline'"
      icon="i-lucide-triangle-alert"
      :loading="sending"
      :aria-pressed="mine"
      @click="flag"
    >
      Report rover not moving
    </UButton>
    <UButton
      v-else
      data-test="flag"
      to="/login"
      size="xs"
      color="warning"
      variant="outline"
      icon="i-lucide-triangle-alert"
    >
      Report rover not moving
    </UButton>
    <span class="text-muted">
      <span data-test="flag-count" class="tabular-nums"
        >{{ flags.count }} / {{ flags.quorum }}</span
      >
      flags
    </span>
  </div>
</template>
