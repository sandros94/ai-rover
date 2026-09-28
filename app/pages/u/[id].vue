<script setup lang="ts">
import type { ProfileSubmission } from '#shared/utils/profile'

// TODO: per-mission breakdown once a user can span several missions
const route = useRoute('u-id')
const id = computed(() => route.params.id)
const { data, error } = await useFetch(() => `/api/users/${id.value}`)

const profile = computed(() => data.value ?? null)
const memberSince = computed(() =>
  profile.value
    ? new Date(profile.value.user.memberSince).toLocaleDateString(undefined, { dateStyle: 'long' })
    : '',
)
const stats = computed(() => {
  const s = profile.value?.stats
  if (!s) return []
  return [
    { label: 'Submissions', value: String(s.submissions), test: 'stat-submissions' },
    { label: 'Rounds won', value: String(s.wins), test: 'stat-wins' },
    { label: 'Driven on their goals', value: `${Math.round(s.drivenM)} m`, test: 'stat-driven' },
    { label: 'LGTMs received', value: String(s.lgtmsReceived), test: 'stat-lgtms' },
    { label: 'Deaths on their goals', value: String(s.deaths), test: 'stat-deaths' },
  ]
})

const SUBMISSION_STATUS = {
  open: { color: 'info', label: 'Open' },
  won: { color: 'success', label: 'Won' },
  lost: { color: 'neutral', label: 'Lost' },
} as const satisfies Record<ProfileSubmission['status'], { color: string; label: string }>

function submittedAt(submission: ProfileSubmission) {
  return new Date(submission.createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

useSeoMeta({
  title: () => (profile.value ? `${profile.value.user.displayName} · AI Rover` : 'AI Rover'),
})
</script>

<template>
  <UContainer class="space-y-4 py-4">
    <SiteHeader />
    <UAlert
      v-if="error"
      data-test="profile-missing"
      color="neutral"
      variant="subtle"
      :title="
        (error as { statusCode?: number }).statusCode === 404
          ? 'No such user.'
          : 'The profile did not load.'
      "
    />
    <template v-else-if="profile">
      <section class="flex items-center gap-4" data-test="profile-card">
        <UAvatar
          :src="profile.user.avatarUrl ?? undefined"
          :alt="profile.user.displayName"
          size="3xl"
        />
        <div class="min-w-0 space-y-1">
          <h1 class="truncate text-lg font-semibold" data-test="profile-name">
            {{ profile.user.displayName }}
          </h1>
          <div class="flex items-center gap-2 text-muted">
            <UIcon
              v-for="provider in profile.user.providers"
              :key="provider"
              :name="PROVIDER_DISPLAY[provider].icon"
              :aria-label="PROVIDER_DISPLAY[provider].label"
              :data-test="`profile-provider-${provider}`"
              class="size-4"
            />
            <span class="text-sm" data-test="profile-since">Member since {{ memberSince }}</span>
          </div>
        </div>
      </section>

      <dl class="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div
          v-for="stat in stats"
          :key="stat.label"
          class="rounded-lg border border-default px-3 py-2"
        >
          <dt class="text-xs text-muted">{{ stat.label }}</dt>
          <dd class="text-base font-semibold tabular-nums" :data-test="stat.test">
            {{ stat.value }}
          </dd>
        </div>
      </dl>

      <section class="space-y-2">
        <h2 class="text-sm font-semibold">Submissions</h2>
        <p
          v-if="profile.submissions.length === 0"
          data-test="profile-empty"
          class="text-sm text-muted"
        >
          No destination submitted yet.
        </p>
        <ul v-else class="divide-y divide-(--ui-border) rounded-lg border border-default">
          <li
            v-for="submission in profile.submissions"
            :key="submission.id"
            data-test="profile-submission"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          >
            <span class="w-16 tabular-nums text-muted">Round {{ submission.round }}</span>
            <span class="tabular-nums" data-test="submission-distance"
              >{{ Math.round(submission.goalDistanceM) }} m</span
            >
            <span class="tabular-nums" data-test="submission-likes"
              >{{ submission.likes }} LGTM{{ submission.likes === 1 ? '' : 's' }}</span
            >
            <UBadge
              :color="SUBMISSION_STATUS[submission.status].color"
              variant="subtle"
              size="sm"
              data-test="submission-status"
            >
              {{ SUBMISSION_STATUS[submission.status].label }}
            </UBadge>
            <template v-if="submission.drive">
              <UBadge
                v-if="submission.drive.status === 'driving'"
                color="neutral"
                variant="outline"
                size="sm"
                data-test="submission-drive"
              >
                Driving
              </UBadge>
              <span v-else class="flex items-center gap-1">
                <UBadge
                  :color="DRIVE_STATUS[submission.drive.status].color"
                  variant="outline"
                  size="sm"
                  data-test="submission-drive"
                >
                  {{ DRIVE_STATUS[submission.drive.status].label }}
                </UBadge>
                <span class="tabular-nums text-muted"
                  >{{ Math.round(submission.drive.distanceM) }} m driven</span
                >
              </span>
            </template>
            <span class="text-muted sm:ml-auto">{{ submittedAt(submission) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </UContainer>
</template>
