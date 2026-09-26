<script setup lang="ts">
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { frameAttitude } from '#shared/utils/client/instruments'
import type { RoverPart } from '#shared/utils/client/scene'
import { framePlacement, ROVER_TONES, roverParts, SCENE_COLORS } from '#shared/utils/client/scene'
import type { ResolvedRoverGeometry } from '#shared/utils/rover'
import { DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values: position, attitude, spins and suspension, used as recorded. */
    frame: Float32Array
    geometry?: ResolvedRoverGeometry
    /** Draw as a red translucent silhouette, for a death marker. */
    ghost?: boolean
  }>(),
  { geometry: () => DEFAULT_ROVER_GEOMETRY, ghost: false },
)

const partsAt = (frame: Float32Array) => roverParts(frameAttitude(frame), props.geometry)
const initial = partsAt(props.frame)
const boxCount = initial.filter((part) => part.shape === 'box').length
const cylinderCount = initial.length - boxCount

const root = new Group()
const unitBox = new BoxGeometry(1, 1, 1)
const unitCylinder = new CylinderGeometry(0.5, 0.5, 1, 20)
const material = props.ghost
  ? new MeshBasicMaterial({
      color: SCENE_COLORS.death,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
  : new MeshLambertMaterial()
// Two draw calls for the whole rover: every box, then every cylinder, as instances.
const boxes = new InstancedMesh(unitBox, material, boxCount)
const cylinders = new InstancedMesh(unitCylinder, material, cylinderCount)
for (const mesh of [boxes, cylinders]) {
  // The instances move every frame; a stale bounding sphere would cull them.
  mesh.frustumCulled = false
  root.add(mesh)
}
if (!props.ghost) {
  const color = new Color()
  let b = 0
  let c = 0
  for (const part of initial) {
    color.set(ROVER_TONES[part.tone])
    if (part.shape === 'box') boxes.setColorAt(b++, color)
    else cylinders.setColorAt(c++, color)
  }
}

const matrix = new Matrix4()
const position = new Vector3()
const quaternion = new Quaternion()
const scale = new Vector3()

function place(parts: RoverPart[], frame: Float32Array): void {
  const placement = framePlacement(frame)
  root.position.set(placement.position.x, placement.position.y, placement.position.z)
  const q = placement.quaternion
  root.quaternion.set(q.x, q.y, q.z, q.w)
  let b = 0
  let c = 0
  for (const part of parts) {
    position.set(part.position.x, part.position.y, part.position.z)
    quaternion.set(part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w)
    scale.set(part.scale.x, part.scale.y, part.scale.z)
    matrix.compose(position, quaternion, scale)
    if (part.shape === 'box') boxes.setMatrixAt(b++, matrix)
    else cylinders.setMatrixAt(c++, matrix)
  }
  boxes.instanceMatrix.needsUpdate = true
  cylinders.instanceMatrix.needsUpdate = true
}

place(initial, props.frame)
watch(
  () => props.frame,
  (frame) => place(partsAt(frame), frame),
)

onBeforeUnmount(() => {
  boxes.dispose()
  cylinders.dispose()
  unitBox.dispose()
  unitCylinder.dispose()
  material.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
