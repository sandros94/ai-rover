<script setup lang="ts">
import type { MapPoint } from '#shared/utils/mission'
import MissionMap from '~/components/map/MissionMap.vue'
import SubmissionList from '~/components/map/SubmissionList.vue'

const { state, error, serverOffsetMs, refresh } = useMissionState()
const { loggedIn, user } = useUserSession()

const round = computed(() => state.value?.round ?? null)
const submissions = computed(() => round.value?.submissions ?? [])

/** Changes when the rover reaches a new stop, which remounts the map on its terrain. */
const stopKey = computed(() =>
  state.value ? `${state.value.mission.id}:${state.value.currentStop.index}` : null,
)

const highlightId = ref<string | null>(null)
const highlight = computed<{ id: string; goal: MapPoint } | null>(() => {
  const s = submissions.value.find((entry) => entry.id === highlightId.value)
  return s ? { id: s.id, goal: s.goal } : null
})
function select(id: string): void {
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
  await Promise.all([refresh(), loadLikes()])
}

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticker))

const countdown = computed(() => {
  const s = state.value
  if (!s?.round) return 'no round open'
  if (s.round.closesAt) {
    const left = Math.max(0, Date.parse(s.round.closesAt) - (now.value + serverOffsetMs.value))
    const minutes = Math.floor(left / 60_000)
    const seconds = Math.floor((left % 60_000) / 1000)
    return `vote closes in ${minutes}:${String(seconds).padStart(2, '0')}`
  }
  return s.segment ? 'voting open' : 'rover idle'
})

const noMission = computed(
  () => (error.value as { statusCode?: number; status?: number } | null)?.status === 404,
)

async function onSubmitted(): Promise<void> {
  await refresh()
}
</script>

<template>
  <UContainer class="space-y-4 py-4">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="text-lg font-semibold">Jev Rover</h1>
      <UBadge v-if="state" color="neutral" variant="subtle" :label="countdown" />
      <div class="ml-auto">
        <UserMenu />
      </div>
    </header>

    <UAlert v-if="noMission" color="neutral" variant="subtle" title="No mission has landed yet." />
    <UAlert
      v-else-if="error && !state"
      color="error"
      variant="subtle"
      title="The mission state did not load."
    />

    <ClientOnly>
      <MissionMap
        v-if="state && stopKey"
        :key="stopKey"
        :state="state"
        :server-offset-ms="serverOffsetMs"
        :signed-in="loggedIn"
        :highlight="highlight"
        @submitted="onSubmitted"
      >
        <section class="space-y-2">
          <h2 class="text-sm font-semibold">Submissions</h2>
          <SubmissionList
            :submissions="submissions"
            :user-id="user?.id ?? null"
            :liked-ids="likedIds"
            :highlight-id="highlightId"
            :can-like="loggedIn"
            @select="select"
            @like="like"
          />
        </section>
      </MissionMap>
    </ClientOnly>
  </UContainer>
</template>
