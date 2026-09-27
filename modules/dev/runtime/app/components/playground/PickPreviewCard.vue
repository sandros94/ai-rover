<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PreviewResult } from '#shared/utils/client'
import { previewPlan } from '#shared/utils/client'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { StopDisk } from '#shared/utils/terrain'
import { DEFAULT_STOP_RADIUS, surveyMask } from '#shared/utils/terrain'
import PickPreview from '~/components/map/PickPreview.vue'
import { PLAYGROUND_PROPS } from '../../playground/registry'

const props = defineProps(PLAYGROUND_PROPS)

const disk = computed<StopDisk | undefined>(() => {
  if (!props.disk) return undefined
  const survey = { center: props.disk.center, radius: DEFAULT_STOP_RADIUS }
  return { ...props.disk, ...survey, inside: surveyMask(props.disk, survey), chunks: [] }
})

const start = computed(() => props.record.start)
/** Points around the record's start that exercise each state of the card. */
const cases = computed(() => {
  const { x, y } = start.value
  return {
    'record goal': props.record.goal,
    'too short': { x: x + 20, y: y + 10 },
    'too long': { x: x + 300, y },
    'north 150 m': { x, y: y + 150 },
  }
})
type Case = keyof typeof cases.value
const selected = ref<Case>('record goal')

/* Planned on the main thread: a card needs one result, not the worker. */
const result = computed<PreviewResult | undefined>(() => {
  if (!disk.value) return undefined
  return previewPlan(disk.value, {
    revealed: disk.value.visible,
    anchor: { x: start.value.x, y: start.value.y },
    point: cases.value[selected.value],
    deaths: [],
    rules: DEFAULT_MISSION_RULES,
    slopeLimitDeg: 16,
  })
})
</script>

<template>
  <div class="max-w-sm space-y-3">
    <div class="flex flex-wrap gap-1">
      <UButton
        v-for="name in Object.keys(cases) as Case[]"
        :key="name"
        size="xs"
        :variant="name === selected ? 'solid' : 'outline'"
        color="neutral"
        @click="selected = name"
      >
        {{ name }}
      </UButton>
    </div>
    <PickPreview :result="result" picked signed-in />
  </div>
</template>
