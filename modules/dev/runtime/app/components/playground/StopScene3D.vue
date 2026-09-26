<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { createTerrainSampler } from '#shared/utils/client'
import { chunksFromGrid } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { Chunk } from '#shared/utils/terrain'
import { PLAYGROUND_PROPS } from '../../playground/registry'

const props = defineProps(PLAYGROUND_PROPS)

// Lazy: three.js loads with the scene, never with the playground shell.
const StopScene = defineAsyncComponent(
  () =>
    // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
    import('~/components/scene/StopScene.vue'),
)

/** The dev world's default chunk: 64 cells of 1 m. */
const CHUNK_VERTICES = 65
/** A made-up death behind the start so the ghost shows on every fixture, metres from the start. */
const DEMO_DEATH_M = 35

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

const cut = computed(() =>
  props.disk
    ? chunksFromGrid(props.disk.grid, props.disk.origin, CHUNK_VERTICES, props.disk.visible)
    : [],
)

const heightAt = computed(() => {
  const byKey = new Map<string, Chunk>()
  for (const { chunk } of cut.value) {
    byKey.set(`${chunk.cx},${chunk.cy}`, { ...chunk, masks: new Uint8Array(chunk.heights.length) })
  }
  const sampler = createTerrainSampler({
    geometry: { vertexCount: CHUNK_VERTICES, cellSize: props.disk?.grid.cellSize ?? 1 },
    peek: (cx, cy) => byKey.get(`${cx},${cy}`),
  })
  return (x: number, y: number) => sampler.heightAt(x, y)
})

const heightRange = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const h of props.disk?.grid.heights ?? []) {
    if (Number.isNaN(h)) continue
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
  return min <= max ? { min, max } : { min: 0, max: 1 }
})

const t = computed(() => props.frame[field('t')]!)
const stops = computed(() => [{ x: props.record.start.x, y: props.record.start.y }])

const deaths = computed(() => {
  const { start, goal, outcome, keyframes } = props.record
  const away = Math.atan2(start.y - goal.y, start.x - goal.x)
  const demo = {
    x: start.x + DEMO_DEATH_M * Math.cos(away),
    y: start.y + DEMO_DEATH_M * Math.sin(away),
    headingRad: away + Math.PI,
  }
  const out = [{ ...demo, z: heightAt.value(demo.x, demo.y) ?? 0 }]
  if (outcome.kind === 'failed') {
    const o = (keyframes.count - 1) * KEYFRAME_STRIDE
    out.push({
      ...outcome.endPose,
      z: keyframes.data[o + field('z')]!,
    })
  }
  return out
})
</script>

<template>
  <div v-if="disk" class="space-y-2">
    <div class="h-[70vh] min-h-80 overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <StopScene
          :frame="frame"
          :chunks="cut"
          :height-range="heightRange"
          :height-at="heightAt"
          :stops="stops"
          :keyframes="record.keyframes"
          :t="t"
          :route="record.plan.polyline"
          :deaths="deaths"
        />
      </ClientOnly>
    </div>
    <p class="text-xs text-muted">
      {{ cut.length }} chunks · drag to orbit, wheel or pinch to zoom · the red ghost
      {{ DEMO_DEATH_M }} m behind the start is a demo death, not from the record.
    </p>
  </div>
  <p v-else class="text-muted">This scene needs the stop disk.</p>
</template>
