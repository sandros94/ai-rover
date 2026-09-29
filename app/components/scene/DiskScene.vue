<script setup lang="ts">
import type { ToneMapping } from 'three'
import type { FogSurface, GridRect, GroundView, MapObject, RoverObject } from '#shared/utils/client'
import { fogSurface, gridHeightAt, ROVER_ID } from '#shared/utils/client'
import type { ChunkFog, TerrainChunk } from '#shared/utils/client/scene'
import { chunkFromGrid, chunksFromGrid, flatFrame } from '#shared/utils/client/scene'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { HeightGrid } from '#shared/utils/terrain'
import type { RevealFrame } from '~/composables/useRevealFade'
import FloatingObjectCard from '~/components/inspect/FloatingObjectCard.vue'
import type { Pickable } from './ScenePicker.vue'
import StopScene from './StopScene.vue'

/**
 * A stop disk in 3D with what the 2D map draws over it: the rover at the playback frame (or at
 * rest), the route and its destination, the path driven, past stops, deaths, the open round's
 * goals, and the fog over what neither the stop nor the drive so far has seen. Objects are
 * inspected as on the 2D map: a card on hover (or a first tap), focus on a click (or a second
 * tap), the camera easing to the focused object; the recentre control returns it to the rover.
 * Ground still arriving is drawn chunk by chunk, each chunk's mesh made once. Load it lazily: it
 * brings three.js.
 */
const props = withDefaults(
  defineProps<{
    /** The disk, whole or still arriving. */
    terrain: GroundView
    /** The stop's own seen flags, one byte per disk vertex: where unseen ground sits. */
    seen?: Uint8Array
    /**
     * The fog drawn, newly seen ground fading in, by `useRevealFade` over `seen` with what the
     * playing drive has seen lifted; without it no fog is drawn.
     */
    fade?: RevealFrame
    /**
     * One byte per disk vertex, 1 where the rover has the ground in sight now; revealed ground
     * out of it, or all of it while there is none, is drawn as seen before.
     */
    sight?: Uint8Array
    /** Vertices per chunk side, as the chunk cache reports them. */
    chunkVertices: number
    /** The stop's survey: ground beyond it is not drawn, a ring marks its edge. */
    survey?: { center: MapPoint; radius: number }
    heightAt: (x: number, y: number) => number | undefined
    /** The 19 keyframe values at the playback time; without a drive the rover rests at `rest`. */
    frame?: Float32Array
    rest: { x: number; y: number; headingRad: number }
    keyframes?: KeyframeBlock
    /** Sim seconds, for the path driven so far. */
    t?: number
    route?: MapPoint[]
    /** The stops shown, the one the rover stands at or left from `current`. */
    stops?: (MapPoint & { current?: boolean })[]
    /**
     * Death positions; a ghost faces `headingRad` when known, else north-east. A death with an
     * `id` is the death object of that id: focused, its ghost gains the full model.
     */
    deaths?: (MapPoint & { headingRad?: number; id?: string })[]
    deathRadiusM?: number
    /**
     * Stops, deaths, submissions and the destination to inspect; submissions are drawn as
     * flagged goals, the destination's flag stands at the route's end.
     */
    objects?: readonly MapObject[]
    /** The rover, inspectable. */
    roverObject?: RoverObject
    /** The time of the sol, an exposure offset and a tone mapping to compare, as `StopScene` takes them. */
    lighting?: { solFraction?: number; exposureBias?: number; toneMapping?: ToneMapping }
  }>(),
  {
    seen: undefined,
    fade: undefined,
    sight: undefined,
    survey: undefined,
    frame: undefined,
    keyframes: undefined,
    t: 0,
    route: () => [],
    stops: () => [],
    deaths: () => [],
    deathRadiusM: undefined,
    objects: () => [],
    roverObject: undefined,
    lighting: () => ({}),
  },
)

const layout = computed(() => ({ width: props.terrain.grid.width, origin: props.terrain.origin }))

/** The chunks drawn: an entry per chunk in, kept as it is while the rest of the disk arrives. */
const chunks = shallowRef<{ chunk: TerrainChunk }[]>([])
let chunked: { grid: HeightGrid; vertexCount: number; placed: number } | undefined
function syncChunks(terrain: GroundView): void {
  const { grid, origin, placed } = terrain
  const vertexCount = props.chunkVertices
  if (chunked?.grid !== grid || chunked.vertexCount !== vertexCount) {
    chunked = { grid, vertexCount, placed: 0 }
    chunks.value = placed ? [] : chunksFromGrid(grid, origin, vertexCount)
  }
  if (!placed || placed.length === chunked.placed) return
  const cells = vertexCount - 1
  const added: { chunk: TerrainChunk }[] = []
  for (const rect of placed.slice(chunked.placed)) {
    const coords = { cx: (origin.i + rect.i0) / cells, cy: (origin.j + rect.j0) / cells }
    const chunk = chunkFromGrid(grid, origin, vertexCount, coords)
    if (chunk) added.push({ chunk })
  }
  chunked.placed = placed.length
  chunks.value = [...chunks.value, ...added]
}

const fade = toRef(() => props.fade)

/** Mean height of the ground the stop itself has seen, over the ground in so far. */
const stopMean = computed(() => {
  const seen = props.seen
  let sum = 0
  let count = 0
  const heights = props.terrain.grid.heights
  for (let k = 0; k < heights.length; k++) {
    if (seen && !seen[k]) continue
    const h = heights[k]!
    if (Number.isNaN(h)) continue
    sum += h
    count++
  }
  return count > 0 ? sum / count : 0
})

/**
 * The fog surface, rewritten in place where a reveal or arriving ground changes it; each new
 * value tells the chunks which rectangles to redraw. Unseen ground far from any revealed ground
 * sits at the mean height of what the stop itself has seen, fixed for the stop so it does not
 * drift with reveals; while ground arrives it sits at the mean of what is in, and settles once
 * the last chunk is.
 */
const fog = shallowRef<ChunkFog & { rects?: GridRect[] }>()
let surface: FogSurface | undefined
/** The mean the surface was computed with, and how many placed rectangles it covers. */
let surfaced = { mean: 0, placed: 0 }
watch(
  [fade, () => props.terrain] as const,
  ([frame, terrain], previous) => {
    const placed = terrain.placed ?? []
    if (!frame) {
      surface = undefined
      fog.value = undefined
      syncChunks(terrain)
      return
    }
    const { grid } = terrain
    const same = !!surface && previous?.[1]?.grid === grid
    const refade = frame !== previous?.[0]
    const whole = { i0: 0, j0: 0, i1: grid.width, j1: grid.height }
    // A new stop or a fade without rectangles redraws everything.
    let rects: GridRect[] | undefined = []
    if (!same || (refade && !frame.rects)) {
      surface = fogSurface(grid, frame.fog, { fallback: stopMean.value })
      surfaced = { mean: stopMean.value, placed: placed.length }
      rects = undefined
    } else if ((terrain.complete ?? true) && stopMean.value !== surfaced.mean) {
      fogSurface(grid, frame.fog, { fallback: stopMean.value, into: surface })
      surfaced = { mean: stopMean.value, placed: placed.length }
      rects = [whole]
    } else {
      const fallback = surfaced.mean
      const changed = [...(refade ? frame.rects! : []), ...placed.slice(surfaced.placed)]
      for (const rect of changed) {
        rects.push(fogSurface(grid, frame.fog, { fallback, changed: rect, into: surface }).rect)
      }
      surfaced.placed = placed.length
    }
    syncChunks(terrain)
    if (rects?.length === 0 && fog.value?.surface === surface) return
    fog.value = {
      surface: surface!,
      layout: layout.value,
      rects,
    }
  },
  { immediate: true },
)

/** Height of the ground as drawn: overlays crossing unseen ground follow the fog, not what it hides. */
const drawnHeightAt = computed(() => {
  const current = fog.value
  if (!current) return props.heightAt
  const place = { ...props.terrain.grid, origin: props.terrain.origin }
  return (x: number, y: number) =>
    gridHeightAt(current.surface.heights, place, x, y) ?? props.heightAt(x, y)
})

/** Fixed for the disk, so colours do not shift as the rover moves or ground arrives. */
let measured: { grid: HeightGrid; range: { min: number; max: number } } | undefined
const heightRange = computed(() => {
  const { grid, heightRange: given } = props.terrain
  if (given) return given
  if (measured?.grid !== grid) {
    let min = Infinity
    let max = -Infinity
    for (const h of grid.heights) {
      if (Number.isNaN(h)) continue
      if (h < min) min = h
      if (h > max) max = h
    }
    measured = { grid, range: min <= max ? { min, max } : { min: 0, max: 1 } }
  }
  return measured.range
})

const groundAt = (p: MapPoint) => props.heightAt(p.x, p.y) ?? 0

const frame = computed(() => props.frame ?? flatFrame({ ...props.rest, z: groundAt(props.rest) }))
const ghosts = computed(() =>
  props.deaths.map((d) => ({
    x: d.x,
    y: d.y,
    z: groundAt(d),
    headingRad: d.headingRad ?? Math.PI / 4,
    ...(d.id === undefined ? {} : { id: d.id }),
  })),
)

/* Inspecting. */

const goals = computed(() =>
  props.objects
    .filter((o) => o.kind === 'submission')
    .map((o) => ({ id: o.id, x: o.x, y: o.y, z: groundAt(o) })),
)
/** Where an object stands: the destination's flag on the ground as drawn, like the route. */
const standAt = (o: MapObject) =>
  o.kind === 'destination' ? (drawnHeightAt.value(o.x, o.y) ?? 0) : groundAt(o)
/** Changes only when the rover becomes inspectable or stops being: not with every frame. */
const roverInspectable = computed(() => props.roverObject !== undefined)
const pickables = computed((): Pickable[] => [
  ...props.objects.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, z: standAt(o) })),
  // The picker moves the rover's volume with the rover.
  ...(roverInspectable.value ? [{ id: ROVER_ID, kind: 'rover' as const, x: 0, y: 0, z: 0 }] : []),
])
const find = (id: string | null | undefined): MapObject | undefined =>
  id === ROVER_ID ? props.roverObject : props.objects.find((o) => o.id === id)

const mapFocus = useMapFocus()
/** Where the camera looks while an object other than the rover is focused: its middle. */
const focusTarget = computed(() => {
  const id = mapFocus.focused.value
  const object = id && id !== ROVER_ID ? find(id) : undefined
  return object && { x: object.x, y: object.y, z: standAt(object) + 1 }
})

const hovered = shallowRef<{ id: string; client: { x: number; y: number } } | null>(null)
const hoveredObject = computed(() => find(hovered.value?.id))

function onHover(id: string | null, client: { x: number; y: number }): void {
  hovered.value = id ? { id, client } : null
}

function onTap(id: string | null, pointerType: string, client: { x: number; y: number }): void {
  if (!id) {
    hovered.value = null
    return
  }
  // A finger has no hover: its first tap shows the card, the second focuses.
  if (pointerType !== 'mouse' && hovered.value?.id !== id) {
    hovered.value = { id, client }
    return
  }
  if (pointerType !== 'mouse') hovered.value = null
  mapFocus.focusOn(id)
}
</script>

<template>
  <div
    data-test="scene"
    class="relative h-full w-full touch-none overflow-hidden bg-(--ui-bg-muted)"
  >
    <StopScene
      v-bind="lighting"
      :frame="frame"
      :chunks="chunks"
      :height-range="heightRange"
      :height-at="heightAt"
      :stops="stops"
      :keyframes="keyframes"
      :t="t"
      :route="route"
      :deaths="ghosts"
      :death-radius-m="deathRadiusM"
      :fog="fog"
      :sight="sight"
      :survey="survey"
      :drawn-height-at="drawnHeightAt"
      :goals="goals"
      :pickables="pickables"
      :focused-id="mapFocus.focused.value"
      :focus-target="focusTarget"
      :focus-key="mapFocus.seq.value"
      @hover="onHover"
      @tap="onTap"
    />
    <div class="absolute right-2 bottom-20 flex flex-col gap-1">
      <UButton
        data-test="recenter"
        icon="i-lucide-crosshair"
        size="xs"
        color="neutral"
        variant="solid"
        aria-label="Recentre on the rover"
        @click="mapFocus.recentre()"
      />
    </div>
    <FloatingObjectCard
      v-if="hovered && hoveredObject"
      :object="hoveredObject"
      :client="hovered.client"
    />
  </div>
</template>
