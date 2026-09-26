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
  title: () =>
    data.value ? `Segment ${data.value.drive.number} · Jev Rover` : 'Segment · Jev Rover',
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
      <h1 class="text-base font-semibold">Segment</h1>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="This segment cannot be replayed."
      description="It is still driving, or it does not exist."
    />
  </UContainer>
  <div v-else class="h-dvh">
    <ClientOnly>
      <DriveReplay
        :key="data.drive.id"
        :drives="[data.drive]"
        :mission="data.mission"
        :trail="data.trail"
        :deaths="data.deaths"
        :next="data.next ? { to: `/drives/${data.next.id}`, number: data.next.number } : null"
      />
      <template #fallback>
        <HudSceneHud view="3d" :panels="[]" />
      </template>
    </ClientOnly>
  </div>
</template>
