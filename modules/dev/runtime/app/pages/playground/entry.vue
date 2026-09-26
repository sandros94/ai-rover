<script setup lang="ts">
import { createError } from '#imports'
import PlaygroundFrame from '../../components/PlaygroundFrame.vue'
import { PLAYGROUND_ENTRIES } from '../../playground/registry'

const props = defineProps<{ id: string }>()

const entry = PLAYGROUND_ENTRIES.find((e) => e.id === props.id)
if (!entry) throw createError({ status: 404, statusText: `No playground entry "${props.id}".` })
</script>

<template>
  <PlaygroundFrame v-if="entry" :entry="entry" />
</template>
