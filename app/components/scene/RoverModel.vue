<script setup lang="ts">
import type { Mesh, Object3D } from 'three'
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
import type { RigNode, RoverPart } from '#shared/utils/client/scene'
import {
  framePlacement,
  rigTransforms,
  ROVER_RIG_NODES,
  ROVER_TONES,
  roverParts,
  SCENE_COLORS,
} from '#shared/utils/client/scene'
import type { ResolvedRoverGeometry } from '#shared/utils/rover'
import { DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import type { RoverVariant } from '~/composables/useRoverVariant'
import { loadRoverModel } from '~/utils/rover-model'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values: position, attitude, spins and suspension, used as recorded. */
    frame: Float32Array
    geometry?: ResolvedRoverGeometry
    /** Draw as a red translucent silhouette, for a death marker. */
    ghost?: boolean
    /** Which rover to draw; the JPL model by default, the procedural one standing in until it loads. */
    variant?: RoverVariant
  }>(),
  { geometry: () => DEFAULT_ROVER_GEOMETRY, ghost: false, variant: 'model' },
)

const emit = defineEmits<{
  /** The drawn rover changed: the procedural one, or a JPL model once loaded. */
  ready: [info: { variant: RoverVariant; triangles: number; loadMs: number }]
}>()

const baseURL = useRuntimeConfig().app.baseURL

const partsAt = (frame: Float32Array) => roverParts(frameAttitude(frame), props.geometry)
const initial = partsAt(props.frame)
const boxCount = initial.filter((part) => part.shape === 'box').length
const cylinderCount = initial.length - boxCount

const root = new Group()
/** The procedural rover: drawn while the model loads, and when it cannot. */
const placeholder = new Group()
root.add(placeholder)
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
  placeholder.add(mesh)
}
const proceduralTriangles =
  (boxCount * unitBox.index!.count + cylinderCount * unitCylinder.index!.count) / 3
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

/** The JPL model in place, with its articulated nodes and their rest rotations. */
let model:
  | { object: Object3D; joints: { node: Object3D; rest: Quaternion; name: RigNode }[] }
  | undefined
const turn = new Quaternion()

function pose(frame: Float32Array): void {
  if (!model) return place(partsAt(frame), frame)
  const rig = rigTransforms(frame)
  root.position.set(rig.position.x, rig.position.y, rig.position.z)
  root.quaternion.set(rig.quaternion.x, rig.quaternion.y, rig.quaternion.z, rig.quaternion.w)
  for (const { node, rest, name } of model.joints) {
    const q = rig.joints[name]
    node.quaternion.copy(rest).multiply(turn.set(q.x, q.y, q.z, q.w))
  }
}

/** Draws the JPL model `object` in place of the current rover, or the procedural one without it. */
function showModel(object: Object3D | undefined): void {
  const joints = object
    ? ROVER_RIG_NODES.map((name) => {
        const node = object.getObjectByName(name)
        if (!node) throw new Error(`RoverModel: the rover model has no node ${name}.`)
        return { node, rest: node.quaternion.clone(), name }
      })
    : []
  if (model) root.remove(model.object)
  model = object && { object, joints }
  placeholder.visible = !object
  if (object) {
    if (props.ghost) {
      object.traverse((child) => {
        if ((child as Mesh).isMesh) (child as Mesh).material = material
      })
    }
    root.add(object)
  }
  pose(props.frame)
}

let unmounted = false
watch(
  () => props.variant,
  async (wanted) => {
    if (wanted === 'procedural') {
      showModel(undefined)
      emit('ready', { variant: wanted, triangles: proceduralTriangles, loadMs: 0 })
      return
    }
    try {
      const loaded = await loadRoverModel(baseURL)
      if (unmounted || props.variant !== wanted) return
      showModel(loaded.scene.clone())
      emit('ready', { variant: wanted, triangles: loaded.triangles, loadMs: loaded.loadMs })
    } catch (error) {
      // The procedural rover stays: the scene works without the download.
      console.warn('RoverModel: the rover model did not load; drawing the procedural rover.', error)
    }
  },
  { immediate: true },
)
watch(() => props.frame, pose)

onBeforeUnmount(() => {
  unmounted = true
  // Only the procedural rover's resources: the loaded model's are shared by every rover on the page.
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
