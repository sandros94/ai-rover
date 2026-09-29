<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { LinearToneMapping } from 'three'
import { useRoute, useScenePassTiming, useSceneQuality, useStopFog } from '#imports'
import { createTerrainSampler, destinationObject } from '#shared/utils/client'
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

/**
 * Lighting controls: the time of the sol and an exposure offset, opened from `?sol=` and
 * `?bias=` for repeatable screenshots, and `?look=linear` for three's plain linear tone mapping
 * in place of the scene's AgX look.
 */
const route = useRoute()
const queryNumber = (name: string, fallback: number) => {
  const value = Number(route.query[name])
  return typeof route.query[name] === 'string' && Number.isFinite(value) ? value : fallback
}
const sol = ref(queryNumber('sol', 0.4))
const bias = ref(queryNumber('bias', 0))
const linear = route.query.look === 'linear'
/** A cycle plays a whole sol in this many seconds. */
const CYCLE_S = 60
const cycling = ref(false)
let raf = 0
let last = 0
function turn(now: number): void {
  sol.value = (sol.value + (now - last) / 1000 / CYCLE_S) % 1
  last = now
  raf = requestAnimationFrame(turn)
}
watch(cycling, (on) => {
  cancelAnimationFrame(raf)
  if (!on) return
  last = performance.now()
  raf = requestAnimationFrame(turn)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))
const lighting = computed(() => ({
  solFraction: sol.value,
  exposureBias: bias.value,
  ...(linear ? { toneMapping: LinearToneMapping } : {}),
}))
const clock = computed(() => {
  const minutes = Math.floor(sol.value * 24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

/** The viewer's scene quality, as the settings will set it, and what drawing costs at it. */
const { choice, deviceTier } = useSceneQuality()
const tiers = computed(() => [
  { label: `Auto (${deviceTier.value})`, value: 'auto' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
])
const timing = useScenePassTiming()
const ms = (value: number) => value.toFixed(2)

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
/** The stop's fog with the drive's reveals lifted, and the rover's sight at the scrub time. */
const fog = useStopFog({
  seen: () => props.disk?.visible,
  reveals: () => reveals.value,
  ground: () => terrain.value,
  eye: () => ({ x: props.frame[field('x')]!, y: props.frame[field('y')]! }),
  sight: () => ({ mastHeight: DEFAULT_MAST_HEIGHT, radiusM: DEFAULT_STOP_RADIUS }),
})

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
    <div class="flex flex-wrap items-center gap-4 text-sm">
      <label class="flex min-w-64 flex-1 items-center gap-2">
        <span class="w-24 font-mono tabular-nums">Sol {{ clock }}</span>
        <USlider v-model="sol" :min="0" :max="1" :step="0.001" aria-label="Time of the sol" />
      </label>
      <label class="flex min-w-48 items-center gap-2">
        <span class="w-24 font-mono tabular-nums"
          >{{ bias >= 0 ? '+' : '' }}{{ bias.toFixed(1) }} EV</span
        >
        <USlider v-model="bias" :min="-3" :max="3" :step="0.1" aria-label="Exposure bias" />
      </label>
      <USwitch v-model="cycling" :label="`Cycle a sol in ${CYCLE_S} s`" />
      <USelect
        v-model="choice"
        :items="tiers"
        class="w-40"
        aria-label="Scene quality"
        data-test="scene-quality"
      />
    </div>
    <div class="mx-auto max-w-[min(100%,70vh)] overflow-hidden rounded-md border border-default">
      <ClientOnly>
        <DiskScene
          class="aspect-square"
          :terrain="terrain"
          :seen="disk.visible"
          :fade="fog.fade"
          :sight="fog.sight"
          :chunk-vertices="CHUNK_VERTICES"
          :height-at="heightAt"
          :frame="frame"
          :rest="rest"
          :keyframes="record.keyframes"
          :t="t"
          :route="record.plan.polyline"
          :stops="stops"
          :deaths="deaths"
          :objects="objects"
          :lighting="lighting"
        />
      </ClientOnly>
    </div>
    <p v-if="timing" class="font-mono text-xs tabular-nums" data-test="pass-timing">
      {{ timing.fps.toFixed(0) }} fps · GPU shadow {{ ms(timing.shadowMs) }} ms + main
      {{ ms(timing.mainMs) }} ms<template v-if="!timing.timed"> (no timer queries)</template> · CPU
      {{ ms(timing.cpuMs) }} ms · {{ timing.calls.toFixed(0) }} calls ({{
        timing.shadowCalls.toFixed(0)
      }}
      shadow) · {{ (timing.triangles / 1000).toFixed(0) }}k triangles ({{
        (timing.shadowTriangles / 1000).toFixed(0)
      }}k shadow) · dpr {{ timing.pixelRatio }} · {{ timing.gpu }}
    </p>
    <p class="text-xs text-muted">
      {{ cut.length }} chunks · {{ reveals.length }} / {{ record.reveals.length }} reveals · drag to
      orbit, wheel or pinch to zoom · the red ghost {{ DEMO_DEATH_M }} m behind the start is a demo
      death and the two grey-headed posts are demo earlier stops, none from the record; the
      destination's author is made up.
    </p>
  </div>
  <p v-else class="text-muted">This scene needs the stop disk.</p>
</template>
