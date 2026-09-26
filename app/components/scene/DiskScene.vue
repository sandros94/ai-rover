<script setup lang="ts">
import { chunksFromGrid, flatFrame } from '#shared/utils/client/scene'
import type { KeyframeBlock } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import StopScene from './StopScene.vue'

/**
 * A stop disk in 3D with what the 2D map draws over it: the rover at the playback frame (or at
 * rest), the route, the path driven, past stops, deaths and the fog lifted by the drive. Load it
 * lazily: it brings three.js.
 */
const props = withDefaults(
  defineProps<{
    terrain: { grid: HeightGrid; origin: GridCell }
    /** The stop's own seen flags, one byte per disk vertex. */
    seen?: Uint8Array
    /** Vertices per chunk side, as the chunk cache reports them. */
    chunkVertices: number
    heightAt: (x: number, y: number) => number | undefined
    /** The 19 keyframe values at the playback time; without a drive the rover rests at `rest`. */
    frame?: Float32Array
    rest: { x: number; y: number; headingRad: number }
    keyframes?: KeyframeBlock
    /** Sim seconds, for the path driven so far. */
    t?: number
    route?: MapPoint[]
    stops?: MapPoint[]
    /** Death positions; a ghost faces `headingRad` when known, else north-east. */
    deaths?: (MapPoint & { headingRad?: number })[]
    deathRadiusM?: number
    /** What the playing drive has seen so far, as disk-grid vertex indices. */
    reveals?: readonly { vertices: ArrayLike<number> }[]
  }>(),
  {
    seen: undefined,
    frame: undefined,
    keyframes: undefined,
    t: 0,
    route: () => [],
    stops: () => [],
    deaths: () => [],
    deathRadiusM: undefined,
    reveals: () => [],
  },
)

const chunks = computed(() =>
  chunksFromGrid(props.terrain.grid, props.terrain.origin, props.chunkVertices, props.seen),
)
const layout = computed(() => ({ width: props.terrain.grid.width, origin: props.terrain.origin }))

/** Fixed for the disk, so colours do not shift as the rover moves. */
const heightRange = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const h of props.terrain.grid.heights) {
    if (Number.isNaN(h)) continue
    if (h < min) min = h
    if (h > max) max = h
  }
  return min <= max ? { min, max } : { min: 0, max: 1 }
})

const groundAt = (p: MapPoint) => props.heightAt(p.x, p.y) ?? 0

const frame = computed(() => props.frame ?? flatFrame({ ...props.rest, z: groundAt(props.rest) }))
const ghosts = computed(() =>
  props.deaths.map((d) => ({
    x: d.x,
    y: d.y,
    z: groundAt(d),
    headingRad: d.headingRad ?? Math.PI / 4,
  })),
)
</script>

<template>
  <div
    data-test="scene"
    class="relative aspect-square w-full touch-none overflow-hidden rounded-lg bg-(--ui-bg-muted)"
  >
    <StopScene
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
      :reveals="reveals"
      :layout="layout"
    />
  </div>
</template>
