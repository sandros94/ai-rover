<script setup lang="ts">
import { rankRound } from '#shared/utils/client/instruments'
import { formatDriveTime } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
import VoteCard from './VoteCard.vue'

/** The open round: its cards in standing order, LGTMs, and which card's route the map shows. */
const props = defineProps<{ state: MissionStateJson }>()
/** An LGTM changed the mission state. */
const emit = defineEmits<{ changed: [] }>()
const highlightId = defineModel<string | null>('highlightId', { default: null })

const { loggedIn, user } = useUserSession()
const round = computed(() => props.state.round)
/** The planned drive time a destination must fit, in words. */
const timeBand = computed(() => {
  const { minS, maxS } = props.state.mission.rules.segmentTimeBand
  return `${formatDriveTime(minS)} to ${formatDriveTime(maxS)}`
})

/** Standing order: the submission that would win now comes first. */
const ranked = computed(() => {
  const s = props.state
  return s.round ? rankRound(s.round.submissions, { rules: s.mission.rules }) : []
})

function toggleHighlight(id: string): void {
  highlightId.value = highlightId.value === id ? null : id
}

const readError = useRequestError()
/** Why the last LGTM or its retraction failed; cleared by the next. */
const likeError = ref<string | null>(null)

const likedIds = ref<string[]>([])
async function loadLikes(): Promise<void> {
  if (!loggedIn.value || !round.value) {
    likedIds.value = []
    return
  }
  const liked = await $fetch('/api/mission/likes').catch(async (caught: unknown) => {
    await readError(caught)
    return null
  })
  likedIds.value = liked?.submissionIds ?? []
}
watch([loggedIn, () => round.value?.id], loadLikes, { immediate: true })

async function like(id: string, on: boolean): Promise<void> {
  likeError.value = null
  try {
    await $fetch(`/api/mission/submissions/${id}/like`, { method: on ? 'PUT' : 'DELETE' })
  } catch (caught) {
    likeError.value = (await readError(caught)).message
  }
  emit('changed')
  await loadLikes()
}
</script>

<template>
  <section data-test="round" class="space-y-2" aria-labelledby="round-heading">
    <div class="flex items-baseline justify-between gap-2">
      <h2 id="round-heading" class="text-sm font-semibold">Next destination</h2>
      <span class="text-xs text-muted">
        {{ state.segment ? 'Vote closes when the drive ends' : `Stop ${state.currentStop.index}` }}
      </span>
    </div>
    <p v-if="likeError" data-test="like-error" role="alert" class="text-xs text-error">
      {{ likeError }}
    </p>
    <p v-if="!loggedIn" class="text-xs text-muted">
      <ULink to="/login" class="underline">Sign in</ULink> to LGTM or submit a destination.
    </p>
    <p v-if="!round" data-test="round-empty" class="text-sm text-muted">
      No round is open right now.
    </p>
    <p v-else-if="ranked.length === 0" data-test="round-empty" class="text-sm text-muted">
      <template v-if="state.segment">
        No destinations yet for the next drive: pick one inside the survey ring, a drive of
        {{ timeBand }}.
      </template>
      <template v-else>
        The rover is idle at stop {{ state.currentStop.index }}: the first destination picked inside
        the survey ring starts a {{ Math.round(state.mission.rules.graceWindowMs / 60_000) }}-minute
        planning phase.
      </template>
    </p>
    <VoteCard
      v-for="s in ranked"
      :key="s.id"
      :submission="s"
      :anchor="round!.anchor"
      :liked="likedIds.includes(s.id)"
      :mine="s.submitter.id === user?.id"
      :signed-in="loggedIn"
      :highlighted="s.id === highlightId"
      @like="like(s.id, $event)"
      @highlight="toggleHighlight(s.id)"
    />
  </section>
</template>
