<script setup lang="ts">
import type { MapPoint } from '#shared/utils/mission'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import type { MissionStateJson } from '~/composables/useMissionState'

type Submission = NonNullable<MissionStateJson['round']>['submissions'][number]

const props = withDefaults(
  defineProps<{
    submission: Submission
    /** Where the round measures goals from. */
    anchor: MapPoint
    liked?: boolean
    /** Submitted by the signed-in user. */
    mine?: boolean
    /** Liking needs a signed-in user; signed out, the button leads to sign-in. */
    signedIn?: boolean
    /** Its route is the one drawn on the map. */
    highlighted?: boolean
  }>(),
  { liked: false, mine: false, signedIn: false, highlighted: false },
)

const emit = defineEmits<{ like: [liked: boolean]; highlight: [] }>()

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** Distance and bearing, clockwise from north (world +y), of the goal from the anchor. */
const goal = computed(() => {
  const dx = props.submission.goal.x - props.anchor.x
  const dy = props.submission.goal.y - props.anchor.y
  const degrees = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
  return {
    distanceM: Math.hypot(dx, dy),
    degrees: Math.round(degrees) % 360,
    compass: COMPASS[Math.round(degrees / 45) % 8]!,
  }
})

const route = computed(() => {
  const r = props.submission.summary.route
  return r.reached ? `${r.path_length_m} m path · ${r.estimated_drive_minutes} min` : null
})
</script>

<template>
  <div
    class="space-y-2 rounded-lg border p-3 transition-colors"
    :class="highlighted ? 'border-(--ui-warning) bg-(--ui-bg-elevated)' : 'border-default'"
  >
    <div class="flex items-center gap-2">
      <UAvatar
        :src="submission.submitter.avatarUrl ?? undefined"
        :alt="submission.submitter.displayName"
        size="xs"
      />
      <span class="truncate text-sm font-medium">{{ submission.submitter.displayName }}</span>
      <UBadge v-if="mine" label="yours" size="sm" variant="subtle" />
      <div class="ml-auto flex items-center gap-1">
        <UButton
          data-test="highlight"
          size="xs"
          color="neutral"
          :variant="highlighted ? 'soft' : 'ghost'"
          icon="i-lucide-map-pin"
          :aria-pressed="highlighted"
          :aria-label="highlighted ? 'Hide route on the map' : 'Show route on the map'"
          @click="emit('highlight')"
        />
        <UButton
          v-if="signedIn"
          data-test="like"
          size="xs"
          :variant="liked ? 'solid' : 'outline'"
          icon="i-lucide-heart"
          :aria-pressed="liked"
          :aria-label="liked ? 'Remove like' : 'Like'"
          @click="emit('like', !liked)"
        >
          {{ submission.likes }}
        </UButton>
        <UButton
          v-else
          data-test="like"
          to="/login"
          size="xs"
          variant="outline"
          icon="i-lucide-heart"
          aria-label="Sign in to like"
        >
          {{ submission.likes }}
        </UButton>
      </div>
    </div>
    <p class="flex flex-wrap gap-x-3 text-xs text-muted">
      <span data-test="goal" class="tabular-nums">
        {{ Math.round(goal.distanceM) }} m · {{ goal.degrees }}° {{ goal.compass }}
      </span>
      <span v-if="route" class="tabular-nums">{{ route }}</span>
    </p>
    <JudgmentCard :judgment="submission.judgment" />
  </div>
</template>
