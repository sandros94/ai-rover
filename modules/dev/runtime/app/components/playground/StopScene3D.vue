<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useCurrentSight } from '#imports'
import { createTerrainSampler, destinationObject, liftSeen } from '#shared/utils/client'
import { chunksFromGrid } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import type { Chunk } from '#shared/utils/terrain'
import { DEFAULT_MAST_HEIGHT, DEFAULT_STOP_RADIUS } from '#shared/utils/terrain'
import { fixtureSegment } from '../../playground/fixtures'
import { PLAYGROUND_PROPS, useRevealsUntil } from '../../playground/registry'

const props = defineProps(PLAYGROUND_PROPS)

// Lazy: three.js loads with the scene, never with the playground shell.
const DiskScene = defineAsyncComponent(
  () =>
    // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
    import('~/components/scene/DiskScene.vue'),
)

/** The dev world's default chunk: 64 cells of 1 m. */
const CHUNK_VERTICES = 65
/** A made-up death behind the start so the ghost shows on every fixture, metres from the start. */
const DEMO_DEATH_M = 35
/**
 * Made-up earlier stops behind the start so past posts show beside the current one: metres from
 * the start and radians off straight behind it, clear of the demo death.
 */
const DEMO_STOPS = [
  { distanceM: 12, offRad: 0.5 },
  { distanceM: 24, offRad: -0.4 },
]

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

const cut = computed(() =>
  props.disk ? chunksFromGrid(props.disk.grid, props.disk.origin, CHUNK_VERTICES) : [],
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

/** One object per disk: a new one each frame would redraw all of the ground each frame. */
const terrain = computed(() => props.disk && { grid: props.disk.grid, origin: props.disk.origin })

const t = computed(() => props.frame[field('t')]!)
/** Straight back from the goal through the start. */
const away = computed(() => {
  const { start, goal } = props.record
  return Math.atan2(start.y - goal.y, start.x - goal.x)
})
const stops = computed(() => {
  const { start } = props.record
  const earlier = DEMO_STOPS.map(({ distanceM, offRad }) => ({
    x: start.x + distanceM * Math.cos(away.value + offRad),
    y: start.y + distanceM * Math.sin(away.value + offRad),
  })).reverse()
  return [...earlier, { x: start.x, y: start.y, current: true }]
})
const rest = computed(() => ({ ...props.record.start }))
/** The flag at the route's end, inspectable as the live map's: hover for its card, click to focus. */
const objects = computed(() => {
  const { start } = props.record
  const destination = destinationObject(
    {
      currentStop: { index: DEMO_STOPS.length, x: start.x, y: start.y },
      trail: stops.value,
      segment: fixtureSegment(props.record),
    },
    props.record.plan.polyline,
  )
  return destination ? [destination] : []
})
/** What the drive has revealed by the scrub time, lifting the fog as it goes. */
const reveals = useRevealsUntil(
  () => props.record,
  () => t.value,
)
/** What the rover has in line of sight at the scrub time, across the whole disk. */
const sight = useCurrentSight(
  () => props.disk && liftSeen(props.disk.visible, reveals.value),
  () => terrain.value,
  () => ({ x: props.frame[field('x')]!, y: props.frame[field('y')]! }),
  () => ({ mastHeight: DEFAULT_MAST_HEIGHT, radiusM: DEFAULT_STOP_RADIUS }),
)

const deaths = computed(() => {
  const { start, outcome } = props.record
  const demo = {
    x: start.x + DEMO_DEATH_M * Math.cos(away.value),
    y: start.y + DEMO_DEATH_M * Math.sin(away.value),
    headingRad: away.value + Math.PI,
  }
  const out = [demo]
  if (outcome.kind === 'failed') out.push({ ...outcome.endPose })
  return out
})
</script>

<template>
  <div v-if="disk && terrain" class="space-y-2">
    <div class="mx-auto max-w-[min(100%,70vh)] overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <DiskScene
          class="aspect-square"
          :terrain="terrain"
          :seen="disk.visible"
          :sight="sight"
          :chunk-vertices="CHUNK_VERTICES"
          :height-at="heightAt"
          :frame="frame"
          :rest="rest"
          :keyframes="record.keyframes"
          :t="t"
          :route="record.plan.polyline"
          :stops="stops"
          :deaths="deaths"
          :reveals="reveals"
          :objects="objects"
        />
      </ClientOnly>
    </div>
    <p class="text-xs text-muted">
      {{ cut.length }} chunks · {{ reveals.length }} / {{ record.reveals.length }} reveals · drag to
      orbit, wheel or pinch to zoom · the red ghost {{ DEMO_DEATH_M }} m behind the start is a demo
      death and the two grey-headed posts are demo earlier stops, none from the record; the
      destination's author is made up.
    </p>
  </div>
  <p v-else class="text-muted">This scene needs the stop disk.</p>
</template>
