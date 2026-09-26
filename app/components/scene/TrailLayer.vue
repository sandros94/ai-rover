<script setup lang="ts">
import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { KeyframeBlock } from '#shared/utils/drive'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { Point3 } from '#shared/utils/rover'
import { ribbonMesh, SCENE_COLORS } from '#shared/utils/client/scene'
import { overlayGeometry } from '~/utils/scene-geometry'

const props = withDefaults(
  defineProps<{
    /** Past stops, drawn as posts. */
    stops?: { x: number; y: number }[]
    /** The segment's keyframes; the path is drawn up to `t`. */
    keyframes?: KeyframeBlock
    /** Sim seconds. */
    t?: number
    heightAt?: (x: number, y: number) => number | undefined
  }>(),
  { stops: () => [], keyframes: undefined, t: 0, heightAt: undefined },
)

/** Posts: metres. */
const POST = { radius: 0.12, height: 3 }
/** Path points closer than this to the last kept one are skipped. */
const PATH_SPACING_M = 0.5
const PATH = { widthM: 0.7, liftM: 0.06 }

const root = new Group()
const postGeometry = new CylinderGeometry(POST.radius, POST.radius, POST.height, 10)
const postMaterial = new MeshLambertMaterial({ color: SCENE_COLORS.stop })
const pathMaterial = new MeshBasicMaterial({
  color: SCENE_COLORS.driven,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
})
let posts: InstancedMesh | undefined
let path: Mesh | undefined
/** Keyframe time of each ribbon point, for the draw range at `t`. */
let pathTimes: number[] = []

function drawPosts(): void {
  if (posts) {
    root.remove(posts)
    posts.dispose()
  }
  posts = undefined
  if (props.stops.length === 0) return
  posts = new InstancedMesh(postGeometry, postMaterial, props.stops.length)
  const matrix = new Matrix4()
  // The cylinder stands along its local y; turned to world z.
  const upright = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
  const one = new Vector3(1, 1, 1)
  props.stops.forEach((stop, k) => {
    const z = props.heightAt?.(stop.x, stop.y) ?? 0
    matrix.compose(new Vector3(stop.x, stop.y, z + POST.height / 2), upright, one)
    posts!.setMatrixAt(k, matrix)
  })
  posts.computeBoundingSphere()
  root.add(posts)
}

function drawPath(): void {
  if (path) {
    root.remove(path)
    path.geometry.dispose()
  }
  path = undefined
  pathTimes = []
  const block = props.keyframes
  if (!block || block.count < 2) return
  const [T, X, Y, Z] = (['t', 'x', 'y', 'z'] as const).map((name) => KEYFRAME_FIELDS.indexOf(name))
  const points: Point3[] = []
  for (let k = 0; k < block.count; k++) {
    const o = k * KEYFRAME_STRIDE
    const x = block.data[o + X!]!
    const y = block.data[o + Y!]!
    const last = points.at(-1)
    if (last && Math.hypot(x - last.x, y - last.y) < PATH_SPACING_M && k < block.count - 1) continue
    points.push({ x, y, z: props.heightAt?.(x, y) ?? block.data[o + Z!]! })
    pathTimes.push(block.data[o + T!]!)
  }
  const mesh = ribbonMesh(points, PATH)
  path = new Mesh(overlayGeometry(mesh), pathMaterial)
  path.position.set(mesh.origin.x, mesh.origin.y, mesh.origin.z)
  root.add(path)
  reveal()
}

/** Shows the ribbon up to the last point reached at `t`. */
function reveal(): void {
  if (!path) return
  // Points reached: the first index whose time is past `t`.
  let lo = 0
  let hi = pathTimes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pathTimes[mid]! <= props.t) lo = mid + 1
    else hi = mid
  }
  const reached = lo
  path.geometry.setDrawRange(0, Math.max(0, reached - 1) * 6)
}

watch(() => [props.stops, props.heightAt], drawPosts, { immediate: true })
watch(() => [props.keyframes, props.heightAt], drawPath, { immediate: true })
watch(() => props.t, reveal)

onBeforeUnmount(() => {
  posts?.dispose()
  path?.geometry.dispose()
  postGeometry.dispose()
  postMaterial.dispose()
  pathMaterial.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
