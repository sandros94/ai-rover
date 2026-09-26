<script setup lang="ts">
import type { JourneyRangeQuery } from '~/composables/useJourney'

/**
 * Consecutive settled segments replayed back to back: `?from=&to=` segment numbers, or `?since=`
 * an ISO instant for the drives that ended after it. A range longer than a page plays its first
 * page and continues with the rest.
 */
const route = useRoute()

const single = (raw: unknown) => (typeof raw === 'string' && raw !== '' ? raw : undefined)
const range = computed((): JourneyRangeQuery => {
  const since = single(route.query.since)
  const from = single(route.query.from)
  const to = single(route.query.to)
  return {
    ...(since ? { since } : {}),
    ...(from ? { from: Number(from) } : {}),
    ...(to ? { to: Number(to) } : {}),
  }
})
const { data, error } = await useDriveRange(range)

/** The rest of a range cut to a page, from the drive after the last one played. */
const next = computed(() => {
  const playlist = data.value
  if (!playlist || playlist.total <= playlist.drives.length) return null
  const number = playlist.drives.at(-1)!.number + 1
  const to = range.value.to
  return {
    to: `/drives/replay?from=${number}${to === undefined ? '' : `&to=${to}`}`,
    number,
  }
})

// Its own chunk with the playback and the instruments; the list page stays light.
const DriveReplay = defineAsyncComponent(() =>
  // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
  import('~/components/journey/DriveReplay.vue').then((module) => module.default),
)

useSeoMeta({
  title: () => {
    const drives = data.value?.drives
    if (!drives) return 'Replay · Jev Rover'
    const first = drives[0]!.number
    const last = drives.at(-1)!.number
    return first === last ? `Segment ${first} · Jev Rover` : `Segments ${first}–${last} · Jev Rover`
  },
})
</script>

<template>
  <UContainer v-if="error || !data" class="space-y-4 py-4">
    <SiteHeader />
    <div class="flex items-center gap-2">
      <UButton
        to="/drives"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Back to the journey"
      />
      <h1 class="text-base font-semibold">Replay</h1>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="This replay cannot be played."
      description="Check the segment numbers or the date, then try again."
    />
    <UAlert
      v-else
      data-test="replay-empty"
      color="neutral"
      variant="subtle"
      title="No segment ended in this range."
    />
  </UContainer>
  <div v-else class="h-dvh">
    <ClientOnly>
      <DriveReplay
        :key="JSON.stringify(range)"
        :drives="data.drives"
        :mission="data.mission"
        :trail="data.trail"
        :deaths="data.deaths"
        :next="next"
      />
      <template #fallback>
        <HudSceneHud view="3d" :panels="[]" />
      </template>
    </ClientOnly>
  </div>
</template>
