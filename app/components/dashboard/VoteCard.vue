<script setup lang="ts">
import { goalBearing } from '#shared/utils/client'
import type { MapPoint } from '#shared/utils/mission'
import { rankingScore } from '#shared/utils/mission'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import type { MissionStateJson } from '~/composables/useMissionState'

type Submission = NonNullable<MissionStateJson['round']>['submissions'][number]

const props = withDefaults(
  defineProps<{
    submission: Submission
    /** Where the round measures goals from. */
    anchor: MapPoint
    /** The signed-in user gave it an LGTM. */
    liked?: boolean
    /** Submitted by the signed-in user. */
    mine?: boolean
    /** An LGTM needs a signed-in user; signed out, the button leads to sign-in. */
    signedIn?: boolean
    /** Its route is the one drawn on the map. */
    highlighted?: boolean
  }>(),
  { liked: false, mine: false, signedIn: false, highlighted: false },
)

const emit = defineEmits<{ like: [liked: boolean]; highlight: [] }>()

/** Distance and bearing, clockwise from north (world +y), of the goal from the anchor. */
const goal = computed(() => goalBearing(props.anchor, props.submission.goal))

/** What the standing is ranked by, beside the LGTMs it comes from. */
const score = computed(() => rankingScore(props.submission).toFixed(2))

/** The code's parts of the exploration value, in words, for the hover. */
const explorationParts = computed(() => {
  const p = props.submission.explorationParts
  return `Path in fog ${p.pathInFog.toFixed(2)} · goal in fog ${p.goalInFog.toFixed(2)} · pocket ${p.pocket.toFixed(2)}; averaged with Jev's own score`
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
      <UBadge
        v-if="submission.deferred"
        data-test="deferred"
        label="others take precedence"
        color="neutral"
        size="sm"
        variant="outline"
        title="Written by the author of the drive in progress: it wins only if nobody else's is left."
      />
      <div class="ml-auto flex items-center gap-1">
        <UTooltip text="Ranking score: √LGTMs × (1 + exploration)">
          <span
            data-test="score"
            class="px-1 text-xs text-muted tabular-nums"
            tabindex="0"
            :aria-label="`Ranking score ${score}, the square root of the LGTMs times one plus the exploration`"
          >
            score {{ score }}
          </span>
        </UTooltip>
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
          icon="i-lucide-thumbs-up"
          :aria-pressed="liked"
          aria-label="LGTM"
          @click="emit('like', !liked)"
        >
          {{ submission.likes }} LGTM
        </UButton>
        <UButton
          v-else
          data-test="like"
          to="/login"
          size="xs"
          variant="outline"
          icon="i-lucide-thumbs-up"
          aria-label="Sign in to LGTM"
        >
          {{ submission.likes }} LGTM
        </UButton>
      </div>
    </div>
    <p class="flex flex-wrap gap-x-3 text-xs text-muted">
      <span data-test="goal" class="tabular-nums">
        {{ Math.round(goal.distanceM) }} m · {{ goal.degrees }}° {{ goal.compass }}
      </span>
      <span v-if="route" class="tabular-nums">{{ route }}</span>
      <span v-if="submission.goalInFog" data-test="goal-in-fog">destination unexplored</span>
      <UTooltip :text="explorationParts">
        <span
          data-test="exploration"
          class="tabular-nums underline decoration-dotted underline-offset-2"
          tabindex="0"
          :aria-label="`Exploration ${submission.exploration.toFixed(2)}: ${explorationParts}`"
        >
          Exploration {{ submission.exploration.toFixed(2) }}
        </span>
      </UTooltip>
    </p>
    <JudgmentCard :judgment="submission.judgment" />
  </div>
</template>
