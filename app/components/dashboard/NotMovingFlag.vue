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

const readError = useRequestError()
const mine = ref(false)
const sending = ref(false)
/** Why the last flag failed, when it says more than a drive that ended meanwhile. */
const flagError = ref<string | null>(null)

async function loadMine(): Promise<void> {
  if (!props.signedIn) {
    mine.value = false
    return
  }
  const answer = await $fetch<{ mine: boolean }>(
    `/api/mission/segments/${props.segmentId}/flag`,
  ).catch(async (caught: unknown) => {
    await readError(caught)
    return null
  })
  mine.value = answer?.mine ?? false
}
watch(() => [props.segmentId, props.signedIn], loadMine, { immediate: true })

async function flag(): Promise<void> {
  sending.value = true
  flagError.value = null
  try {
    await $fetch(`/api/mission/segments/${props.segmentId}/flag`, { method: 'PUT' })
    mine.value = true
    emit('changed')
  } catch (caught) {
    const error = await readError(caught)
    // Otherwise the drive may have ended meanwhile; the next state poll shows where it stands.
    if (error.code === 'USER_GONE') flagError.value = error.message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-xs">
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
    <p v-if="flagError" data-test="flag-error" role="alert" class="w-full text-error">
      {{ flagError }}
    </p>
  </div>
</template>
