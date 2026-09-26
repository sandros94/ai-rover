<script setup lang="ts">
const route = useRoute('drives-segmentId')
const segmentId = computed(() => route.params.segmentId)
const { data, error } = await useDriveReplay(segmentId)

// Its own chunk with the playback and the instruments; the list page stays light.
const DriveReplay = defineAsyncComponent(() =>
  // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
  import('~/components/journey/DriveReplay.vue').then((module) => module.default),
)

useSeoMeta({
  title: () => (data.value ? `Drive ${data.value.drive.number} · Jev Rover` : 'Drive · Jev Rover'),
})
</script>

<template>
  <UContainer class="space-y-4 py-4">
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
      <h1 class="text-base font-semibold">
        {{ data ? `Drive ${data.drive.number}` : 'Drive' }}
      </h1>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="This drive cannot be replayed."
      description="It is still driving, or it does not exist."
    />
    <ClientOnly v-else-if="data">
      <DriveReplay :replay="data" />
    </ClientOnly>
  </UContainer>
</template>
