<script setup lang="ts">
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import type { ChunkMesh, DiskLayout, LodLevel, TerrainChunk } from '#shared/utils/client/scene'
import {
  chunkDistance,
  chunkLevel,
  chunkMesh,
  DEFAULT_SKIRT_M,
  fogDelta,
  LOD_STEPS,
  recolourChunkMesh,
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
  /**
   * Vertices a playing drive has seen so far, as indices of the stop disk grid laid out by
   * `layout`: lifted from the fog on top of each chunk's own `seen`.
   */
  reveals?: readonly { vertices: ArrayLike<number> }[]
  layout?: DiskLayout
}>()

/** Distance the focus must move before levels are re-evaluated. */
const REFRESH_M = 8
/** Fog updates per second, as the 2D map's: reveals arrive every metre, not every frame. */
const REVEAL_HZ = 10

interface Drawn {
  source: { chunk: TerrainChunk; seen?: Uint8Array }
  level: LodLevel
  mesh: Mesh
  /** Geometry per level with the colours it holds, built on first use. */
  built: ({ geometry: BufferGeometry; colors: ChunkMesh } | undefined)[]
  /** The seen flags drawn, when the drive's reveals have changed them from the source's. */
  shown?: Uint8Array
}

const root = new Group()
// Shading is baked into the vertex colours, so the terrain needs no lights.
const material = new MeshBasicMaterial({ vertexColors: true })
const drawn = new Map<string, Drawn>()
let lastFocus: { x: number; y: number } | undefined

const keyOf = (chunk: TerrainChunk) => `${chunk.cx},${chunk.cy}`

function meshOptions(chunk: TerrainChunk, level: LodLevel, seen: Uint8Array | undefined) {
  const heightAt = props.heightAt
  return {
    heightRange: props.heightRange,
    step: LOD_STEPS[level],
    skirtM: DEFAULT_SKIRT_M,
    seen,
    heightOutside:
      heightAt && ((i: number, j: number) => heightAt(i * chunk.cellSize, j * chunk.cellSize)),
  }
}

function build(entry: Drawn, level: LodLevel): NonNullable<Drawn['built'][number]> {
  const chunk = entry.source.chunk
  const mesh = chunkMesh(chunk, meshOptions(chunk, level, entry.shown ?? entry.source.seen))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  geometry.computeBoundingSphere()
  return { geometry, colors: mesh }
}

function show(entry: Drawn, level: LodLevel): void {
  entry.level = level
  entry.built[level] ??= build(entry, level)
  entry.mesh.geometry = entry.built[level]!.geometry
}

function drop(entry: Drawn): void {
  for (const built of entry.built) built?.geometry.dispose()
  entry.built = []
}

const reveals = useThrottled(() => props.reveals, REVEAL_HZ)

/** Recolours, on the levels built so far, only the vertices whose fog the reveals change. */
function applyFog(): void {
  const layout = props.layout
  if (!layout) return
  const entries = [...drawn.values()]
  const changes = fogDelta(
    entries.map((e) => ({ chunk: e.source.chunk, base: e.source.seen, shown: e.shown })),
    reveals.value ?? [],
    layout,
  )
  for (const change of changes) {
    const entry = drawn.get(change.key)!
    entry.shown = change.seen
    entry.built.forEach((built, level) => {
      if (!built) return
      const options = meshOptions(entry.source.chunk, level as LodLevel, change.seen)
      recolourChunkMesh(built.colors, entry.source.chunk, { ...options, vertices: change.vertices })
      built.geometry.getAttribute('color').needsUpdate = true
    })
  }
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
      entry.shown = undefined
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

watch(
  () => props.chunks,
  () => {
    sync()
    applyFog()
  },
  { immediate: true },
)
watch([reveals, () => props.layout], applyFog)
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
