<script setup lang="ts">
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import type { LodLevel, TerrainChunk } from '#shared/utils/client/scene'
import {
  chunkDistance,
  chunkLevel,
  chunkMesh,
  DEFAULT_SKIRT_M,
  LOD_STEPS,
} from '#shared/utils/client/scene'

const props = defineProps<{
  /** The chunks to draw, each with its seen flags; a new array or entry redraws what changed. */
  chunks: { chunk: TerrainChunk; seen?: Uint8Array }[]
  /** Height mapped to the ends of the colour ramp, fixed for the scene so colours do not shift. */
  heightRange: { min: number; max: number }
  /** Where full resolution is kept: the rover. */
  focus: { x: number; y: number }
  /** World height at a point, for shading chunk edges from their neighbours. */
  heightAt?: (x: number, y: number) => number | undefined
}>()

/** Distance the focus must move before levels are re-evaluated. */
const REFRESH_M = 8

interface Drawn {
  source: { chunk: TerrainChunk; seen?: Uint8Array }
  level: LodLevel
  mesh: Mesh
  /** Geometry per level, built on first use. */
  built: (BufferGeometry | undefined)[]
}

const root = new Group()
// Shading is baked into the vertex colours, so the terrain needs no lights.
const material = new MeshBasicMaterial({ vertexColors: true })
const drawn = new Map<string, Drawn>()
let lastFocus: { x: number; y: number } | undefined

const keyOf = (chunk: TerrainChunk) => `${chunk.cx},${chunk.cy}`

function build(entry: Drawn['source'], level: LodLevel): BufferGeometry {
  const { chunk, seen } = entry
  const heightAt = props.heightAt
  const mesh = chunkMesh(chunk, {
    heightRange: props.heightRange,
    step: LOD_STEPS[level],
    skirtM: DEFAULT_SKIRT_M,
    seen,
    heightOutside: heightAt && ((i, j) => heightAt(i * chunk.cellSize, j * chunk.cellSize)),
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

function show(entry: Drawn, level: LodLevel): void {
  entry.level = level
  entry.built[level] ??= build(entry.source, level)
  entry.mesh.geometry = entry.built[level]!
}

function drop(entry: Drawn): void {
  for (const geometry of entry.built) geometry?.dispose()
  entry.built = []
}

function sync(): void {
  const focus = props.focus
  const wanted = new Map(props.chunks.map((source) => [keyOf(source.chunk), source]))
  const arrived: TerrainChunk[] = []
  for (const [key, entry] of drawn) {
    if (wanted.has(key)) continue
    drop(entry)
    root.remove(entry.mesh)
    drawn.delete(key)
  }
  for (const [key, source] of wanted) {
    const level = chunkLevel(chunkDistance(source.chunk, focus), drawn.get(key)?.level)
    let entry = drawn.get(key)
    if (!entry) {
      const mesh = new Mesh(undefined, material)
      const { cx, cy, vertexCount, cellSize } = source.chunk
      const size = (vertexCount - 1) * cellSize
      mesh.position.set(cx * size, cy * size, 0)
      mesh.updateMatrix()
      mesh.matrixAutoUpdate = false
      root.add(mesh)
      entry = { source, level, mesh, built: [] }
      drawn.set(key, entry)
      arrived.push(source.chunk)
    } else if (entry.source !== source) {
      drop(entry)
      entry.source = source
    } else if (entry.level === level) {
      continue
    }
    show(entry, level)
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
  lastFocus = { ...focus }
}

watch(() => props.chunks, sync, { immediate: true })
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
