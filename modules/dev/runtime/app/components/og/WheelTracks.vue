<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
} from 'three'
import { DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'

/**
 * Made-up wheel tracks behind the rover, for staged shots: one band per side, as wide as the
 * front, middle and rear wheels' overlapping ruts, printed with grouser marks. Every vertex
 * stands on the ground as the terrain mesh draws it at full detail, triangle by triangle, so a
 * band follows cross slopes and creases instead of cutting under them. Drawn inside a stop
 * scene's canvas.
 */
const props = defineProps<{
  /** The centre line driven, oldest point first, world metres; it ends under the front axle. */
  path: { x: number; y: number }[]
  ground: { grid: HeightGrid; origin: GridCell }
}>()

const { frontWheel, middleWheel, wheelWidth } = DEFAULT_ROVER_GEOMETRY
/** The ruts' outer edges: the middle wheels run wider than the corner ones. */
const OUTER_M = middleWheel.y + wheelWidth / 2
const INNER_M = frontWheel.y - wheelWidth / 2
const SIDE_M = (OUTER_M + INNER_M) / 2
const HALF_WIDTH_M = (OUTER_M - INNER_M) / 2
/** Vertices across a band, edge to edge. */
const ACROSS = 5
/** Vertex spacing along a band, metres: well under a terrain cell. */
const SPACING_M = 0.1
const LIFT_M = 0.03
/** Grouser marks repeat this often along the track, metres. */
const GROUSER_PERIOD_M = 0.14

/**
 * Height of the terrain mesh at (x, y): the grid's cells are drawn as two triangles split from
 * the cell's low corner to its high one, so the height is interpolated on the triangle holding
 * the point, not bilinearly. Undefined off the grid.
 */
function meshHeightAt(x: number, y: number): number | undefined {
  const { grid, origin } = props.ground
  const fi = x / grid.cellSize - origin.i
  const fj = y / grid.cellSize - origin.j
  if (!(fi >= 0 && fj >= 0 && fi <= grid.width - 1 && fj <= grid.height - 1)) return undefined
  const i = Math.min(Math.floor(fi), grid.width - 2)
  const j = Math.min(Math.floor(fj), grid.height - 2)
  const u = fi - i
  const v = fj - j
  const k = j * grid.width + i
  const h = grid.heights
  const h00 = h[k]!
  const h10 = h[k + 1]!
  const h01 = h[k + grid.width]!
  const h11 = h[k + grid.width + 1]!
  const z =
    u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01)
  return Number.isNaN(z) ? undefined : z
}

/** Grouser marks: darker bars across the track, softer at the band's edges. */
function grouserTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const g = canvas.getContext('2d')!
  g.fillStyle = '#8a8a8a'
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = '#3a3a3a'
  g.fillRect(0, 0, 64, 22)
  const edge = g.createLinearGradient(0, 0, 64, 0)
  edge.addColorStop(0, 'rgba(255,255,255,0.6)')
  edge.addColorStop(0.15, 'rgba(255,255,255,0)')
  edge.addColorStop(0.85, 'rgba(255,255,255,0)')
  edge.addColorStop(1, 'rgba(255,255,255,0.6)')
  g.fillStyle = edge
  g.fillRect(0, 0, 64, 64)
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  return texture
}

const texture = grouserTexture()
const material = new MeshStandardMaterial({
  color: '#6b3d26',
  map: texture,
  roughness: 1,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
})
const group = new Group()

/** The path resampled every `SPACING_M`, each point with its unit direction of travel. */
function resample(path: { x: number; y: number }[]) {
  const out: { x: number; y: number; dx: number; dy: number; along: number }[] = []
  let along = 0
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!
    const b = path[k]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    const dx = (b.x - a.x) / length
    const dy = (b.y - a.y) / length
    const steps = Math.ceil(length / SPACING_M)
    for (let s = out.length === 0 ? 0 : 1; s <= steps; s++) {
      const f = s / steps
      out.push({
        x: a.x + dx * length * f,
        y: a.y + dy * length * f,
        dx,
        dy,
        along: along + length * f,
      })
    }
    along += length
  }
  return out
}

/** One band `sideM` to the left of the path (negative: right), `ACROSS` vertices wide. */
function band(points: ReturnType<typeof resample>, sideM: number): Mesh {
  const first = points[0]!
  const z0 = meshHeightAt(first.x, first.y) ?? 0
  const positions = new Float32Array(points.length * ACROSS * 3)
  const uv = new Float32Array(points.length * ACROSS * 2)
  let z = z0
  points.forEach((p, k) => {
    for (let a = 0; a < ACROSS; a++) {
      const share = a / (ACROSS - 1)
      const offset = sideM + HALF_WIDTH_M - share * 2 * HALF_WIDTH_M
      const x = p.x - p.dy * offset
      const y = p.y + p.dx * offset
      z = meshHeightAt(x, y) ?? z
      const n = k * ACROSS + a
      positions.set([x - first.x, y - first.y, z - z0 + LIFT_M], n * 3)
      uv.set([share, p.along / GROUSER_PERIOD_M], n * 2)
    }
  })
  const indices = new Uint32Array((points.length - 1) * (ACROSS - 1) * 6)
  let t = 0
  for (let k = 0; k < points.length - 1; k++) {
    for (let a = 0; a < ACROSS - 1; a++) {
      const l0 = k * ACROSS + a
      const r0 = l0 + 1
      const l1 = l0 + ACROSS
      const r1 = l1 + 1
      indices.set([l0, r0, r1, l0, r1, l1], t)
      t += 6
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  geometry.setIndex(new BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  const mesh = new Mesh(geometry, material)
  mesh.position.set(first.x, first.y, z0)
  mesh.receiveShadow = true
  return mesh
}

function clear(): void {
  while (group.children.length > 0) {
    const child = group.children[0] as Mesh
    child.geometry.dispose()
    group.remove(child)
  }
}

watch(
  () => [props.path, props.ground],
  () => {
    clear()
    const points = resample(props.path)
    if (points.length < 2) return
    group.add(band(points, SIDE_M), band(points, -SIDE_M))
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clear()
  material.dispose()
  texture.dispose()
})
</script>

<template>
  <primitive :object="group" />
</template>
