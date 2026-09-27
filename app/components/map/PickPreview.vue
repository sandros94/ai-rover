<script setup lang="ts">
import type { PreviewResult } from '#shared/utils/client'
import type { SubmissionRefusal } from '#shared/utils/mission'

const props = withDefaults(
  defineProps<{
    result?: PreviewResult
    /** A plan is being computed for a newer point. */
    pending?: boolean
    /** The point was tapped, so it can be confirmed; a hover only previews. */
    picked?: boolean
    submitting?: boolean
    /** Why the server refused the last confirmed point, when it did. */
    refusal?: { reason: SubmissionRefusal | (string & {}); message: string } | null
    /** Submitting needs a signed-in user; the preview does not. */
    signedIn?: boolean
  }>(),
  {
    result: undefined,
    pending: false,
    picked: false,
    submitting: false,
    refusal: null,
    signedIn: false,
  },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const REASONS: Record<SubmissionRefusal, string> = {
  'unpathable': 'No reachable ground there: pick a spot the rover can get to.',
  'outside': 'Beyond the survey: pick a spot inside the ring.',
  'too-near': 'Too near: a segment is at least 50 m.',
  'too-far': 'Too far: a segment is at most 250 m.',
  'near-death-zone': 'Too close to where the rover was lost before.',
  'path-near-death-zone': 'The route passes too close to where the rover was lost before.',
  'judged-infeasible': 'Jev judged this route infeasible.',
  'too-many-attempts': 'You have used every attempt this round allows.',
  'round-changed':
    'The round moved while your goal was judged: check the new route and confirm again.',
}

/** Error codes the submit route answers besides a refusal. */
const CODES: Record<string, string> = {
  ALREADY_SUBMITTED: 'You already have a submission in this round; withdraw it to submit another.',
  MISSION_PAUSED: 'The mission is paused: submissions resume when it does.',
  NO_OPEN_ROUND: 'No round is open right now.',
  OUT_OF_DISK: 'That point lies beyond the mapped ground.',
}

const knownText = (reason: string): string | undefined =>
  REASONS[reason as SubmissionRefusal] ?? CODES[reason]
const reasonText = (reason: string) => knownText(reason) ?? reason

const rows = computed(() => {
  const result = props.result
  if (!result?.ok || !result.metrics.reached) return []
  const m = result.metrics
  return [
    ['Straight line', `${Math.round(m.straightLineM)} m`],
    ['Path', `${Math.round(m.pathLengthM)} m`],
    ['Detour', `×${m.detourRatio.toFixed(2)}`],
    ['Max seen slope', `${m.maxSlopeDeg.toFixed(1)}°`],
    ['Unseen', `${Math.round(m.unrevealedFraction * 100)} %`],
    ...(m.goalInFog ? [['Destination', 'unexplored']] : []),
    ['Estimated drive', `${result.estimatedMinutes} min`],
  ]
})

const unreached = computed(() => props.result?.ok === true && !props.result.metrics.reached)
</script>

<template>
  <UCard :ui="{ body: 'p-3 sm:p-4' }">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold">Route preview</h2>
      <UIcon v-if="pending" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
    </div>
    <p v-if="!result" class="mt-2 text-sm text-muted">
      Hover or tap inside the ring to preview a route.
    </p>
    <template v-else>
      <UAlert
        v-if="!result.ok"
        class="mt-2"
        color="warning"
        variant="subtle"
        :title="reasonText(result.reason)"
      />
      <UAlert
        v-else-if="unreached"
        class="mt-2"
        color="warning"
        variant="subtle"
        title="No route over the ground the rover knows."
      />
      <dl v-else class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
        <template v-for="[label, value] in rows" :key="label">
          <dt class="text-muted">{{ label }}</dt>
          <dd class="font-mono tabular-nums">{{ value }}</dd>
        </template>
      </dl>
    </template>
    <UAlert
      v-if="refusal"
      class="mt-2"
      color="error"
      variant="subtle"
      :title="knownText(refusal.reason) ?? 'The submission failed.'"
      :description="knownText(refusal.reason) ? undefined : refusal.message"
    />
    <div v-if="picked" class="mt-3 flex gap-2">
      <UButton
        v-if="signedIn"
        :disabled="!result?.ok || pending"
        :loading="submitting"
        icon="i-lucide-flag"
        @click="emit('confirm')"
      >
        Confirm destination
      </UButton>
      <UButton v-else to="/login" icon="i-lucide-log-in" variant="soft">Sign in to submit</UButton>
      <UButton color="neutral" variant="ghost" @click="emit('cancel')">Cancel</UButton>
    </div>
  </UCard>
</template>
