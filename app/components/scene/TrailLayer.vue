<script setup lang="ts">
import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { KeyframeBlock } from '#shared/utils/drive'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { Point3 } from '#shared/utils/rover'
import {
  ribbonMesh,
  SCENE_COLORS,
  STOP_MARKER,
  stopMarkerInstances,
} from '#shared/utils/client/scene'
import { overlayGeometry } from '~/utils/scene-geometry'

const props = withDefaults(
  defineProps<{
    /** The stops shown, the one the rover stands at or left from `current`; drawn as posts. */
    stops?: { x: number; y: number; current?: boolean }[]
    /** The segment's keyframes; the path is drawn up to `t`. */
    keyframes?: KeyframeBlock
    /** Sim seconds. */
    t?: number
    heightAt?: (x: number, y: number) => number | undefined
  }>(),
  { stops: () => [], keyframes: undefined, t: 0, heightAt: undefined },
)

/** Path points closer than this to the last kept one are skipped. */
const PATH_SPACING_M = 0.5
const PATH = { widthM: 0.7, liftM: 0.06 }
/** The contact disc: just above the ground, and faint enough to read as its shadow. */
const CONTACT = { liftM: 0.02, opacity: 0.35 }

const { marker } = SCENE_COLORS
const M = STOP_MARKER
const root = new Group()
// Cylinders stand along their local y; the scene is z-up. Each part is placed from the foot.
const postGeometry = new CylinderGeometry(M.postRadiusM, M.postRadiusM, M.postHeightM, 10)
  .rotateX(Math.PI / 2)
  .translate(0, 0, M.postHeightM / 2)
const sphere = new SphereGeometry(M.sphereRadiusM, 20, 14).translate(0, 0, M.headZ)
const band = new CylinderGeometry(M.bandRadiusM, M.bandRadiusM, M.bandHeightM, 16)
  .rotateX(Math.PI / 2)
  .translate(0, 0, M.bandZ)
const headGeometry = mergeGeometries([sphere, band])!
sphere.dispose()
band.dispose()
const contactGeometry = new CircleGeometry(M.contactRadiusM, 24).translate(0, 0, CONTACT.liftM)
const postMaterial = new MeshStandardMaterial({
  color: marker.post,
  roughness: 0.85,
  metalness: 0,
})
// Instance colours tint the head; a faint glow and no fog keep it readable far off.
const headMaterial = new MeshStandardMaterial({
  color: '#ffffff',
  roughness: 0.3,
  metalness: 0,
  emissive: '#ffffff',
  emissiveIntensity: 0.08,
  fog: false,
})
const contactMaterial = new MeshBasicMaterial({
  color: marker.contact,
  transparent: true,
  opacity: CONTACT.opacity,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
})
const pathMaterial = new MeshBasicMaterial({
  color: SCENE_COLORS.driven,
  toneMapped: false,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
})
const headColors = {
  current: new Color(marker.sphere.current),
  past: new Color(marker.sphere.past),
}
/** Posts, their heads and their contact discs: one instance per stop in each. */
let markers: InstancedMesh[] = []
let path: Mesh | undefined
/** Keyframe time of each ribbon point, for the draw range at `t`. */
let pathTimes: number[] = []

function drawPosts(): void {
  for (const mesh of markers) {
    root.remove(mesh)
    mesh.dispose()
  }
  markers = []
  const instances = stopMarkerInstances(props.stops, props.heightAt ?? (() => undefined))
  if (instances.length === 0) return
  const posts = new InstancedMesh(postGeometry, postMaterial, instances.length)
  const heads = new InstancedMesh(headGeometry, headMaterial, instances.length)
  const contacts = new InstancedMesh(contactGeometry, contactMaterial, instances.length)
  posts.name = 'posts'
  heads.name = 'heads'
  contacts.name = 'contacts'
  const matrix = new Matrix4()
  const position = new Vector3()
  const upright = new Quaternion()
  const tilt = new Quaternion()
  const one = new Vector3(1, 1, 1)
  instances.forEach((instance, k) => {
    position.set(instance.base.x, instance.base.y, instance.base.z)
    matrix.compose(position, upright, one)
    posts.setMatrixAt(k, matrix)
    heads.setMatrixAt(k, matrix)
    heads.setColorAt(k, instance.current ? headColors.current : headColors.past)
    const q = instance.contact
    matrix.compose(position, tilt.set(q.x, q.y, q.z, q.w), one)
    contacts.setMatrixAt(k, matrix)
  })
  markers = [contacts, posts, heads]
  for (const mesh of markers) {
    mesh.computeBoundingSphere()
    root.add(mesh)
  }
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
  for (const mesh of markers) mesh.dispose()
  path?.geometry.dispose()
  for (const geometry of [postGeometry, headGeometry, contactGeometry]) geometry.dispose()
  for (const material of [postMaterial, headMaterial, contactMaterial, pathMaterial]) {
    material.dispose()
  }
})
</script>

<template>
  <primitive :object="root" />
</template>
