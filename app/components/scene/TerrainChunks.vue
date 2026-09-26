<script setup lang="ts">
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import type { GridRect } from '#shared/utils/client'
import type { ChunkFog, ChunkMesh, LodLevel, TerrainChunk } from '#shared/utils/client/scene'
import {
  chunkDistance,
  chunkFogged,
  chunkLevel,
  chunkMesh,
  chunkRect,
  DEFAULT_SKIRT_M,
  FOG_STEP,
  LOD_STEPS,
  refogChunkMesh,
} from '#shared/utils/client/scene'

const props = defineProps<{
  /** The chunks to draw; a new array or entry redraws what changed. */
  chunks: { chunk: TerrainChunk }[]
  /** Height mapped to the ends of the colour ramp, fixed for the scene so colours do not shift. */
  heightRange: { min: number; max: number }
  /** Where full resolution is kept: the rover. */
  focus: { x: number; y: number }
  /** World height at a point, for shading chunk edges from their neighbours. */
  heightAt?: (x: number, y: number) => number | undefined
  /**
   * The stop disk's fog. A new value with `rects` redraws only the chunks meeting those
   * rectangles of the disk grid; without `rects`, every chunk.
   */
  fog?: ChunkFog & { rects?: GridRect[] }
}>()

/** Distance the focus must move before levels are re-evaluated. */
const REFRESH_M = 8
/** Vertex stride per drawn level: the two distance levels, then the one for chunks all fog. */
const STEPS = [...LOD_STEPS, FOG_STEP] as const
const FOG_LEVEL = 2
type Level = LodLevel | typeof FOG_LEVEL

interface Drawn {
  source: { chunk: TerrainChunk }
  level: Level
  mesh: Mesh
  /** Geometry per level with the arrays it holds, built on first use. */
  built: ({ geometry: BufferGeometry; arrays: ChunkMesh } | undefined)[]
  /** Whether the fog covers the whole chunk, as of the fog last applied. */
  fogged: boolean
}

const root = new Group()
// Shading is baked into the vertex colours, so the terrain needs no lights.
const material = new MeshBasicMaterial({ vertexColors: true })
const drawn = new Map<string, Drawn>()
let lastFocus: { x: number; y: number } | undefined

const keyOf = (chunk: TerrainChunk) => `${chunk.cx},${chunk.cy}`

function meshOptions(chunk: TerrainChunk, level: Level) {
  const heightAt = props.heightAt
  const cells = chunk.vertexCount - 1
  return {
    heightRange: props.heightRange,
    step: level === FOG_LEVEL && cells % FOG_STEP !== 0 ? cells : STEPS[level],
    skirtM: DEFAULT_SKIRT_M,
    fog: props.fog,
    heightOutside:
      heightAt && ((i: number, j: number) => heightAt(i * chunk.cellSize, j * chunk.cellSize)),
  }
}

function build(entry: Drawn, level: Level): NonNullable<Drawn['built'][number]> {
  const chunk = entry.source.chunk
  const arrays = chunkMesh(chunk, meshOptions(chunk, level))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(arrays.colors, 3))
  geometry.setIndex(new BufferAttribute(arrays.indices, 1))
  geometry.computeBoundingSphere()
  return { geometry, arrays }
}

function show(entry: Drawn, level: Level): void {
  entry.level = level
  entry.built[level] ??= build(entry, level)
  entry.mesh.geometry = entry.built[level]!.geometry
}

function drop(entry: Drawn): void {
  for (const built of entry.built) built?.geometry.dispose()
  entry.built = []
}

/** The level a chunk should show: the fog level when fog covers all of it, else by distance. */
function levelOf(entry: Pick<Drawn, 'source' | 'fogged'>, current?: Level): Level {
  if (entry.fogged) return FOG_LEVEL
  const held = current === FOG_LEVEL ? undefined : current
  return chunkLevel(chunkDistance(entry.source.chunk, props.focus), held)
}

const isFogged = (chunk: TerrainChunk) => !!props.fog && chunkFogged(chunk, props.fog)

const meets = (a: GridRect, b: GridRect) => a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1

/** Rewrites heights and colours on the levels built so far of the chunks the fog change meets. */
function applyFog(): void {
  const fog = props.fog
  const rects = fog?.rects
  if (!fog || !rects) {
    for (const entry of drawn.values()) {
      drop(entry)
      entry.fogged = isFogged(entry.source.chunk)
      show(entry, levelOf(entry, entry.level))
    }
    return
  }
  for (const entry of drawn.values()) {
    const chunk = entry.source.chunk
    const area = chunkRect(chunk, fog.layout)
    if (!rects.some((rect) => meets(area, rect))) continue
    entry.built.forEach((built, level) => {
      if (!built) return
      refogChunkMesh(built.arrays, chunk, meshOptions(chunk, level as Level))
      built.geometry.getAttribute('position').needsUpdate = true
      built.geometry.getAttribute('color').needsUpdate = true
      built.geometry.computeBoundingSphere()
    })
    entry.fogged = isFogged(chunk)
    const level = levelOf(entry, entry.level)
    if (level !== entry.level) show(entry, level)
  }
}

function sync(): void {
  const wanted = new Map(props.chunks.map((source) => [keyOf(source.chunk), source]))
  const arrived: TerrainChunk[] = []
  for (const [key, entry] of drawn) {
    if (wanted.has(key)) continue
    drop(entry)
    root.remove(entry.mesh)
    drawn.delete(key)
  }
  for (const [key, source] of wanted) {
    let entry = drawn.get(key)
    if (!entry) {
      const mesh = new Mesh(undefined, material)
      const { cx, cy, vertexCount, cellSize } = source.chunk
      const size = (vertexCount - 1) * cellSize
      mesh.position.set(cx * size, cy * size, 0)
      mesh.updateMatrix()
      mesh.matrixAutoUpdate = false
      root.add(mesh)
      entry = { source, level: 0, mesh, built: [], fogged: isFogged(source.chunk) }
      drawn.set(key, entry)
      arrived.push(source.chunk)
      show(entry, levelOf(entry))
      continue
    }
    if (entry.source !== source) {
      drop(entry)
      entry.source = source
      entry.fogged = isFogged(source.chunk)
      show(entry, levelOf(entry, entry.level))
      continue
    }
    const level = levelOf(entry, entry.level)
    if (level !== entry.level) show(entry, level)
  }
  // A chunk's edge colours read its neighbours' heights: redraw those next to new arrivals.
  if (props.heightAt) {
    for (const chunk of arrived) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const neighbour = drawn.get(`${chunk.cx + dx},${chunk.cy + dy}`)
          if (!neighbour || (dx === 0 && dy === 0) || arrived.includes(neighbour.source.chunk))
            continue
          drop(neighbour)
          show(neighbour, neighbour.level)
        }
      }
    }
  }
  lastFocus = { ...props.focus }
}

watch(() => props.chunks, sync, { immediate: true })
watch(() => props.fog, applyFog)
watch(
  () => props.heightRange,
  () => {
    for (const entry of drawn.values()) {
      drop(entry)
      show(entry, entry.level)
    }
  },
)
watch(
  () => props.focus,
  (focus) => {
    if (!lastFocus || Math.hypot(focus.x - lastFocus.x, focus.y - lastFocus.y) >= REFRESH_M) sync()
  },
)

onBeforeUnmount(() => {
  for (const entry of drawn.values()) drop(entry)
  drawn.clear()
  material.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
