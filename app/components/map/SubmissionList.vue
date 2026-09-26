<script setup lang="ts">
import type { MissionStateJson } from '~/composables/useMissionState'

type Submission = NonNullable<MissionStateJson['round']>['submissions'][number]

withDefaults(
  defineProps<{
    submissions: Submission[]
    userId?: string | null
    likedIds?: string[]
    highlightId?: string | null
    /** Likes need a signed-in user. */
    canLike?: boolean
  }>(),
  { userId: null, likedIds: () => [], highlightId: null, canLike: false },
)

const emit = defineEmits<{ select: [id: string]; like: [id: string, liked: boolean] }>()

const VERDICT_COLOR = { accept: 'success', review: 'warning', reject: 'error' } as const
</script>

<template>
  <div class="space-y-2">
    <p v-if="submissions.length === 0" class="text-sm text-muted">No submissions yet.</p>
    <ul class="space-y-2">
      <li
        v-for="s in submissions"
        :key="s.id"
        class="cursor-pointer rounded-lg border p-3 transition-colors"
        :class="
          s.id === highlightId ? 'border-(--ui-warning) bg-(--ui-bg-elevated)' : 'border-default'
        "
        @click="emit('select', s.id)"
      >
        <div class="flex items-center gap-2">
          <UAvatar
            :src="s.submitter.avatarUrl ?? undefined"
            :alt="s.submitter.displayName"
            size="xs"
          />
          <span class="truncate text-sm font-medium">{{ s.submitter.displayName }}</span>
          <UBadge v-if="s.submitter.id === userId" label="yours" size="sm" variant="subtle" />
          <UButton
            class="ml-auto"
            size="xs"
            :variant="likedIds.includes(s.id) ? 'solid' : 'outline'"
            icon="i-lucide-heart"
            :disabled="!canLike"
            :aria-label="likedIds.includes(s.id) ? 'Remove like' : 'Like'"
            @click.stop="emit('like', s.id, !likedIds.includes(s.id))"
          >
            {{ s.likes }}
          </UButton>
        </div>
        <div class="mt-2 flex flex-wrap gap-1">
          <UBadge
            :color="VERDICT_COLOR[s.judgment.verdict]"
            variant="subtle"
            size="sm"
            :label="`feasible ${Math.round(s.judgment.feasible * 100)} %`"
          />
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="`risk ${s.judgment.risk.toFixed(2)}`"
          />
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="`distance conf. ${s.judgment.distanceWeight.toFixed(2)}`"
          />
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="`time conf. ${s.judgment.timeWeight.toFixed(2)}`"
          />
          <UBadge
            v-if="s.summary.route.reached"
            color="neutral"
            variant="outline"
            size="sm"
            :label="`${s.summary.route.path_length_m} m · ${s.summary.route.estimated_drive_minutes} min`"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
