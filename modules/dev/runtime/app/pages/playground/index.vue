<script setup lang="ts">
import { PLAYGROUND_ENTRIES } from '../../playground/registry'

const GROUPS = [
  { group: 'instrument', title: 'Instruments' },
  { group: 'scene', title: 'Scenes' },
  { group: 'card', title: 'Cards' },
].map(({ group, title }) => ({
  title,
  entries: PLAYGROUND_ENTRIES.filter((entry) => entry.group === group),
}))
</script>

<template>
  <UContainer class="max-w-2xl py-10 space-y-6">
    <h1 class="text-xl font-semibold">Playground</h1>
    <section v-for="{ title, entries } in GROUPS" :key="title">
      <h2 class="font-medium">{{ title }}</h2>
      <p v-if="!entries.length" class="text-sm text-muted">None yet.</p>
      <ul class="list-disc pl-5">
        <li v-for="entry in entries" :key="entry.id">
          <ULink :to="`/_dev/playground/${entry.id}`">{{ entry.title }}</ULink>
        </li>
      </ul>
    </section>
  </UContainer>
</template>
