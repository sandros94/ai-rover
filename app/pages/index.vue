<script setup lang="ts">
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'

const { state, error, serverOffsetMs, refresh } = useMissionState()
</script>

<template>
  <UContainer class="space-y-4 py-4">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="text-lg font-semibold">Jev Rover</h1>
      <div class="ml-auto">
        <UserMenu />
      </div>
    </header>
    <MissionDashboard
      :state="state"
      :error="error"
      :server-offset-ms="serverOffsetMs"
      @changed="refresh"
    />
  </UContainer>
</template>
