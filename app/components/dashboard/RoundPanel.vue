<script setup lang="ts">
import { rankSubmissions } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
import VoteCard from './VoteCard.vue'

/** The open round: its cards in standing order, likes, and which card's route the map shows. */
const props = defineProps<{ state: MissionStateJson }>()
/** A like changed the mission state. */
const emit = defineEmits<{ changed: [] }>()
const highlightId = defineModel<string | null>('highlightId', { default: null })

const { loggedIn, user } = useUserSession()
const round = computed(() => props.state.round)

/** Standing order: the submission that would win now comes first. */
const ranked = computed(() => {
  const s = props.state
  if (!s.round) return []
  return rankSubmissions(
    s.round.submissions.map((entry) => ({
      ...entry,
      createdAt: new Date(entry.createdAt),
      judgment: { ...entry.judgment, risk: { score: entry.judgment.risk } },
      source: entry,
    })),
    { rules: s.mission.rules },
  ).map((entry) => entry.source)
})

function toggleHighlight(id: string): void {
  highlightId.value = highlightId.value === id ? null : id
}

const likedIds = ref<string[]>([])
async function loadLikes(): Promise<void> {
  if (!loggedIn.value || !round.value) {
    likedIds.value = []
    return
  }
  const liked = await $fetch('/api/mission/likes').catch(() => null)
  likedIds.value = liked?.submissionIds ?? []
}
watch([loggedIn, () => round.value?.id], loadLikes, { immediate: true })

async function like(id: string, on: boolean): Promise<void> {
  await $fetch(`/api/mission/submissions/${id}/like`, { method: on ? 'PUT' : 'DELETE' }).catch(
    () => undefined,
  )
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
    <p v-if="!loggedIn" class="text-xs text-muted">
      <ULink to="/login" class="underline">Sign in</ULink> to like or submit a destination.
    </p>
    <p v-if="!round" data-test="round-empty" class="text-sm text-muted">
      No round is open right now.
    </p>
    <p v-else-if="ranked.length === 0" data-test="round-empty" class="text-sm text-muted">
      <template v-if="state.segment">
        No destinations yet for the next drive: pick one inside the ring around the planned goal.
      </template>
      <template v-else>
        The rover is idle at stop {{ state.currentStop.index }}: the first destination picked inside
        the ring starts a {{ Math.round(state.mission.rules.graceWindowMs / 60_000) }}-minute vote.
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
