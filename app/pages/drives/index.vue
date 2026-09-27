<script setup lang="ts">
import DriveList from '~/components/journey/DriveList.vue'
import ReplayBar from '~/components/journey/ReplayBar.vue'

const route = useRoute()
const page = computed({
  get: () => {
    const n = Number(route.query.page)
    return Number.isSafeInteger(n) && n > 0 ? n : 1
  },
  set: (next: number) => navigateTo({ query: next > 1 ? { page: next } : {} }),
})
const { data, error } = await useJourneyPage(page)

useSeoMeta({ title: 'Journey · AI Rover' })
</script>

<template>
  <UContainer class="space-y-4 py-4">
    <SiteHeader />
    <h1 class="text-base font-semibold">Journey</h1>
    <p class="text-sm text-muted">
      Every drive that has ended, newest first. Open one to replay it, or replay several back to
      back.
    </p>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="
        (error as { statusCode?: number }).statusCode === 404
          ? 'No mission has landed yet.'
          : 'The journey did not load.'
      "
    />
    <template v-else-if="data">
      <ReplayBar v-if="data.total > 0" :latest="data.total" />
      <DriveList :drives="data.drives" />
      <UPagination
        v-if="data.total > data.pageSize"
        v-model:page="page"
        :total="data.total"
        :items-per-page="data.pageSize"
        size="sm"
      />
    </template>
  </UContainer>
</template>
