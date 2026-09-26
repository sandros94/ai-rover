<script lang="ts">
import type { MapObjectKind } from '#shared/utils/client'

/** An object the pointer can reach in the scene, standing on the ground at `z`. */
export interface Pickable {
  id: string
  kind: MapObjectKind
  x: number
  y: number
  z: number
}
</script>

<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { Intersection, Object3D } from 'three'
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
} from 'three'

/**
 * Finds what the pointer is over in the scene: invisible pick volumes the size of each marker
 * (a stop's post, a ghost, a goal's flag, the rover), raycast from the camera. A mouse moving
 * without a button reports `hover`; a press released where it started (within a few pixels, so
 * orbiting is not a tap) reports `tap`. The rover's volume follows `rover`.
 */
const props = defineProps<{
  pickables: readonly Pickable[]
  /** Where the rover stands now. */
  rover: { x: number; y: number; z: number }
}>()

const emit = defineEmits<{
  hover: [id: string | null, client: { x: number; y: number }]
  tap: [id: string | null, pointerType: string, client: { x: number; y: number }]
}>()

/** Finger or mouse travel, pixels, beyond which a press is an orbit and not a tap. */
const TAP_SLOP_PX = 6

/** Pick volumes, metres: generous enough to hit at a distance, no larger than the marker's reach. */
const VOLUMES: Record<MapObjectKind, { geometry: BoxGeometry | CylinderGeometry; lift: number }> = {
  stop: { geometry: new CylinderGeometry(0.7, 0.7, 3.4, 8), lift: 1.7 },
  death: { geometry: new BoxGeometry(3.4, 3.2, 2.6), lift: 1.2 },
  submission: { geometry: new CylinderGeometry(0.9, 0.9, 2.8, 8), lift: 1.4 },
  rover: { geometry: new BoxGeometry(3.4, 3, 2.6), lift: 1.2 },
}
// Cylinders stand along their local y; the scene is z-up.
for (const kind of ['stop', 'submission'] as const) VOLUMES[kind].geometry.rotateX(Math.PI / 2)

const invisible = new MeshBasicMaterial({ visible: false })
const root = new Group()
let roverVolume: Mesh | undefined

watch(
  () => props.pickables,
  (pickables) => {
    root.clear()
    roverVolume = undefined
    for (const p of pickables) {
      const volume = new Mesh(VOLUMES[p.kind].geometry, invisible)
      volume.position.set(p.x, p.y, p.z + VOLUMES[p.kind].lift)
      volume.userData.pickId = p.id
      if (p.kind === 'rover') roverVolume = volume
      root.add(volume)
    }
  },
  { immediate: true },
)

const { onBeforeRender } = useLoop()
onBeforeRender(() => {
  const { x, y, z } = props.rover
  roverVolume?.position.set(x, y, z + VOLUMES.rover.lift)
})

const { camera, renderer } = useTres()
const raycaster = new Raycaster()
const ndc = new Vector2()
const hits: Intersection<Object3D>[] = []

function pick(event: PointerEvent): string | null {
  const cam = camera.value
  const canvas = renderer.domElement
  if (!cam) return null
  const rect = canvas.getBoundingClientRect()
  ndc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(ndc, cam)
  hits.length = 0
  raycaster.intersectObjects(root.children, false, hits)
  return (hits[0]?.object.userData.pickId as string | undefined) ?? null
}

let press: { id: number; x: number; y: number; moved: boolean } | undefined
/** Hover picks wait for the next frame: one raycast per frame at most. */
let pending: PointerEvent | undefined
let frame = 0

function onMove(event: PointerEvent): void {
  if (press && event.pointerId === press.id) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) {
      press.moved = true
    }
    return
  }
  if (event.pointerType !== 'mouse' || event.buttons !== 0) return
  pending = event
  frame ||= requestAnimationFrame(() => {
    frame = 0
    const last = pending!
    emit('hover', pick(last), { x: last.clientX, y: last.clientY })
  })
}

function onDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
}

function onUp(event: PointerEvent): void {
  if (!press || event.pointerId !== press.id) return
  const tapped = !press.moved
  press = undefined
  if (tapped) emit('tap', pick(event), event.pointerType, { x: event.clientX, y: event.clientY })
}

function onLeave(event: PointerEvent): void {
  // A lifted finger leaves too: a tapped card stays until the next tap.
  if (event.pointerType !== 'mouse') return
  pending = undefined
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  emit('hover', null, { x: 0, y: 0 })
}

const canvas = renderer.domElement
canvas.addEventListener('pointermove', onMove)
canvas.addEventListener('pointerdown', onDown)
canvas.addEventListener('pointerup', onUp)
canvas.addEventListener('pointerleave', onLeave)

onBeforeUnmount(() => {
  canvas.removeEventListener('pointermove', onMove)
  canvas.removeEventListener('pointerdown', onDown)
  canvas.removeEventListener('pointerup', onUp)
  canvas.removeEventListener('pointerleave', onLeave)
  if (frame) cancelAnimationFrame(frame)
  root.clear()
  for (const volume of Object.values(VOLUMES)) volume.geometry.dispose()
  invisible.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
