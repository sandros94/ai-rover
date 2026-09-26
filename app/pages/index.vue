<script setup lang="ts">
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'

const { state, error, serverOffsetMs, refresh } = useMissionState()
</script>

<template>
  <div class="h-dvh">
    <h1 class="sr-only">Mission dashboard</h1>
    <MissionDashboard
      :state="state"
      :error="error"
      :server-offset-ms="serverOffsetMs"
      @changed="refresh"
    />
  </div>
</template>
