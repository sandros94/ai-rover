<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanPreview, useStopFog } from '#imports'
import { destinationObject } from '#shared/utils/client'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { DEFAULT_MAST_HEIGHT, DEFAULT_STOP_RADIUS } from '#shared/utils/terrain'
import PickPreview from '~/components/map/PickPreview.vue'
import StopMap from '~/components/map/StopMap.vue'
import type { PlanGround } from '~/workers/plan-protocol'
import { fixtureSegment } from '../../playground/fixtures'
import { PLAYGROUND_PROPS, useRevealsUntil } from '../../playground/registry'

const props = defineProps(PLAYGROUND_PROPS)

/** What the drive has revealed by the scrub time, lifted from the fog. */
const reveals = useRevealsUntil(
  () => props.record,
  () => props.frame[KEYFRAME_FIELDS.indexOf('t')]!,
)

const value = (name: (typeof KEYFRAME_FIELDS)[number]) =>
  props.frame[KEYFRAME_FIELDS.indexOf(name)]!

const rover = computed(() => {
  const [x, y, z, w] = [value('qx'), value('qy'), value('qz'), value('qw')]
  return {
    x: value('x'),
    y: value('y'),
    headingRad: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  }
})

/** One object per disk: a new one each frame would redraw all of the ground each frame. */
const terrain = computed(() => props.disk && { grid: props.disk.grid, origin: props.disk.origin })

/** The stop's fog with the drive's reveals lifted, and the rover's sight at the scrub time. */
const fog = useStopFog({
  seen: () => props.disk?.visible,
  reveals: () => reveals.value,
  ground: () => terrain.value,
  eye: () => rover.value,
  sight: () => ({ mastHeight: DEFAULT_MAST_HEIGHT, radiusM: DEFAULT_STOP_RADIUS }),
})

const anchor = computed(() => ({ x: props.record.start.x, y: props.record.start.y }))

/** The flag at the route's end, inspectable as the live map's: hover for its card, click to focus. */
const objects = computed(() => {
  const destination = destinationObject(
    {
      currentStop: { index: 0, ...anchor.value },
      trail: [],
      segment: fixtureSegment(props.record),
    },
    props.record.plan.polyline,
  )
  return destination ? [destination] : []
})

/* The dev disk route serves the world's default slope limit and mast height. */
const ground = computed<PlanGround | undefined>(() => {
  const disk = props.disk
  if (!disk) return undefined
  return {
    grid: disk.grid,
    origin: disk.origin,
    traversable: disk.traversable,
    revealed: disk.visible,
    center: disk.center,
    radius: DEFAULT_STOP_RADIUS,
    chunks: [],
    mastHeight: DEFAULT_MAST_HEIGHT,
    slopeLimitDeg: 16,
  }
})
const context = computed(() => ({ anchor: anchor.value, deaths: [], rules: DEFAULT_MISSION_RULES }))
const preview = usePlanPreview(ground, context)
const picked = ref<MapPoint | null>(null)

function onPick(point: MapPoint): void {
  picked.value = point
  preview.requestNow(point)
}
function onHover(point: MapPoint | null): void {
  if (point && !picked.value) preview.request(point)
}
</script>

<template>
  <div v-if="disk" class="grid gap-4 lg:grid-cols-[minmax(0,48rem)_22rem]">
    <StopMap
      class="aspect-square rounded-lg"
      :terrain="terrain"
      :seen="fog.seen"
      :fade="fog.fade"
      :sight="fog.sight"
      :center="disk.center"
      :radius="DEFAULT_STOP_RADIUS"
      :rover="rover"
      :plan="record.plan.polyline"
      :preview="preview.result.value"
      :picked="picked"
      :objects="objects"
      @pick="onPick"
      @hover="onHover"
    />
    <div class="space-y-2">
      <PickPreview
        :result="preview.result.value"
        :pending="preview.pending.value"
        :picked="false"
      />
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs text-muted">
        <dt>worker disk build</dt>
        <dd>{{ preview.buildMs.value?.toFixed(0) ?? '…' }} ms</dd>
        <dt>last plan</dt>
        <dd data-test="plan-ms">{{ preview.planMs.value?.toFixed(0) ?? '—' }} ms</dd>
      </dl>
      <p v-if="picked" class="text-xs text-muted">
        Picked {{ picked.x.toFixed(1) }}, {{ picked.y.toFixed(1) }}
        <button class="underline" @click="picked = null">clear</button>
      </p>
    </div>
  </div>
  <p v-else class="text-muted">This scene needs the stop disk.</p>
</template>
