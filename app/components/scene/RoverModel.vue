<script lang="ts">
let modelIds = 0
/** A fresh id for a rover's entry in the scene's full-model ledger. */
const nextModelId = () => ++modelIds
</script>

<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { Material, Mesh, Object3D, Texture } from 'three'
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
  SpotLight,
  Vector3,
} from 'three'
import { frameAttitude } from '#shared/utils/client/instruments'
import type { FullModelLedger, RigNode, RoverPart } from '#shared/utils/client/scene'
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
import { applyEnvironment, loadRoverModel } from '~/utils/rover-model'

const props = withDefaults(
  defineProps<{
    /** The 19 keyframe values: position, attitude, spins and suspension, used as recorded. */
    frame: Float32Array
    geometry?: ResolvedRoverGeometry
    /**
     * Draw as a red translucent silhouette, for a death marker: the low-poly ghost model, which
     * gains the full one while `detailed`.
     */
    ghost?: boolean
    /** A ghost in focus: the full model crossfades in over the silhouette once decoded. */
    detailed?: boolean
    /** Which rover to draw; the JPL model by default, the procedural one standing in until it loads. */
    variant?: RoverVariant
    /** Who may draw a full model in this scene; without one, nobody waits. */
    ledger?: FullModelLedger
    /** Brightness of the arm turret's white LEDs, 0 off to 1 full; the rover's only lamp. */
    lamp?: number
    /**
     * Camera distance beyond which the rover draws its low-poly model in place of the full one,
     * metres; `null` never. Not for a ghost.
     */
    lodDistanceM?: number | null
    /** What the model's metals and glass reflect; see `SceneEnvironment`. */
    environment?: Texture | null
    /**
     * URDF joint values, radians, by model node name, over the keyframe's: any node carrying a
     * joint (steering, mast, or a rig joint) turned by hand.
     */
    joints?: Readonly<Record<string, number>>
  }>(),
  {
    geometry: () => DEFAULT_ROVER_GEOMETRY,
    ghost: false,
    detailed: false,
    variant: 'model',
    ledger: undefined,
    lamp: 0,
    lodDistanceM: null,
    environment: null,
    joints: undefined,
  },
)

const emit = defineEmits<{
  /** The drawn rover changed: the procedural one, or a JPL model once loaded. */
  ready: [info: { variant: RoverVariant; triangles: number; loadMs: number }]
}>()

const baseURL = useRuntimeConfig().app.baseURL
const { camera, invalidate } = useTres()
const { onBeforeRender } = useLoop()

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
/** A ghost's silhouette opacity; its full model, in focus, is shaded and more opaque. */
const GHOST_OPACITY = { silhouette: 0.3, detailed: 0.7 }
/** How long a focused ghost's full model takes to replace its silhouette, milliseconds. */
const CROSSFADE_MS = 150
const material = props.ghost
  ? new MeshBasicMaterial({
      color: SCENE_COLORS.death,
      toneMapped: false,
      transparent: true,
      opacity: GHOST_OPACITY.silhouette,
      depthWrite: false,
    })
  : new MeshLambertMaterial()
// Two draw calls for the whole rover: every box, then every cylinder, as instances.
const boxes = new InstancedMesh(unitBox, material, boxCount)
const cylinders = new InstancedMesh(unitCylinder, material, cylinderCount)
for (const mesh of [boxes, cylinders]) {
  // The instances move every frame; a stale bounding sphere would cull them.
  mesh.frustumCulled = false
  mesh.castShadow = mesh.receiveShadow = !props.ghost
  placeholder.add(mesh)
}

/**
 * The arm turret's white LEDs around the WATSON camera, the only light the rover carries. On the
 * model it hangs from the `turret` node, at the lens and along the camera's boresight
 * (`extras.beam`), so the cone follows the arm: at night the arm holds the turret up over the
 * front deck, lighting the ground a few metres ahead of the wheels. On the procedural rover it
 * hangs where the turret would be, aimed at the same patch of ground. Always in the scene, at
 * zero by day, so switching it never changes the lit shaders.
 */
const LAMP = {
  candela: 15,
  /** Reach, metres: past the lit patch, which lies about 4.5 m from the raised turret. */
  range: 9,
  /** Half-angle of the cone, radians, and its soft edge. */
  angle: 0.42,
  penumbra: 0.6,
}
/** The procedural rover's turret and the ground the lamp lights, body frame. */
const PROCEDURAL_LAMP = { at: new Vector3(1.25, 0, 0.55), aim: new Vector3(4.45, 0, 0) }
const turretLamp = props.ghost
  ? undefined
  : new SpotLight('#ffe8cc', 0, LAMP.range, LAMP.angle, LAMP.penumbra, 2)
if (turretLamp) {
  hangLamp(root, PROCEDURAL_LAMP.at, PROCEDURAL_LAMP.aim)
  watchEffect(() => (turretLamp.intensity = LAMP.candela * props.lamp))
}

/** The lamp under `parent` at `at`, aimed at `aim`, both in the parent's frame. */
function hangLamp(parent: Object3D, at: Vector3, aim: Vector3): void {
  if (!turretLamp) return
  parent.add(turretLamp, turretLamp.target)
  turretLamp.position.copy(at)
  turretLamp.target.position.copy(aim)
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

/** A JPL model in place, with its articulated nodes and their rest rotations. */
interface Posed {
  object: Object3D
  joints: { node: Object3D; rest: Quaternion; name: RigNode }[]
  /** Nodes kept pointing at a point on another node: the differential's rods. */
  aims: Aim[]
  /** Every node carrying a URDF joint, by name: its rest, axis and the value baked into its rest. */
  jointed: Map<string, { node: Object3D; rest: Quaternion; axis: Vector3; baked: number }>
}

/**
 * A node that turns to keep its rest direction `from` (its own frame) pointing at `point` on
 * `target` (the target's frame), as the model's `extras.aim` declares.
 */
interface Aim {
  node: Object3D
  rest: Quaternion
  target: Object3D
  point: Vector3
  from: Vector3
}
/** The model drawn: the full one for the rover, the silhouette for a ghost. */
let model: Posed | undefined
/** A focused ghost's full model, over or in place of its silhouette. */
let detail: Posed | undefined
/**
 * The rover's low-poly model (the ghosts' silhouette, a fiftieth of the full model's triangles):
 * the shadow caster for the full model, which casts none, and what is drawn in its place beyond
 * `lodDistanceM`. A shadow a few texels of 3 to 12 cm wide shows none of the detail the full
 * model spends its triangles on, and the shadow pass drew them all a second time.
 */
let low: Posed | undefined
/** Writes neither colour nor depth: the low-poly model is then in the shadow pass alone. */
const shadowOnly = new MeshBasicMaterial({ colorWrite: false, depthWrite: false })
const lowShade = new MeshLambertMaterial({ color: ROVER_TONES.deck, flatShading: true })
/** Whether the camera is beyond `lodDistanceM`. */
let far = false
/** How much nearer than `lodDistanceM` the camera must come back to bring the full model back. */
const LOD_MARGIN = 0.1
const turn = new Quaternion()

function posed(object: Object3D): Posed {
  const joints = ROVER_RIG_NODES.map((name) => {
    const node = object.getObjectByName(name)
    if (!node) throw new Error(`RoverModel: the rover model has no node ${name}.`)
    return { node, rest: node.quaternion.clone(), name }
  })
  const aims: Aim[] = []
  const jointed: Posed['jointed'] = new Map()
  object.traverse((node) => {
    const joint = node.userData as {
      joint?: string
      axis?: [number, number, number]
      baked?: number
    }
    if (joint.joint && joint.axis) {
      jointed.set(node.name, {
        node,
        rest: node.quaternion.clone(),
        axis: new Vector3(...joint.axis).normalize(),
        baked: joint.baked ?? 0,
      })
    }
  })
  object.traverse((node) => {
    const aim = node.userData.aim as
      | { node: string; point: [number, number, number]; from: [number, number, number] }
      | undefined
    const target = aim && object.getObjectByName(aim.node)
    if (!aim || !target) return
    aims.push({
      node,
      rest: node.quaternion.clone(),
      target,
      point: new Vector3(...aim.point),
      from: new Vector3(...aim.from).normalize(),
    })
  })
  return { object, joints, aims, jointed }
}

const aimAt = new Vector3()
const aimTurn = new Quaternion()
/** Turns each aimed node, from its rest, so its `from` direction meets its target point. */
function aimAll(posedModel: Posed): void {
  if (!posedModel.aims.length) return
  posedModel.object.updateMatrixWorld(true)
  for (const { node, rest, target, point, from } of posedModel.aims) {
    // The target point in the node's parent frame, then relative to the node at rest.
    node.parent!.worldToLocal(target.localToWorld(aimAt.copy(point)))
    aimAt.sub(node.position).applyQuaternion(aimTurn.copy(rest).invert()).normalize()
    node.quaternion.copy(rest).multiply(aimTurn.setFromUnitVectors(from, aimAt))
  }
}

function pose(frame: Float32Array): void {
  if (!model && !detail) return place(partsAt(frame), frame)
  const rig = rigTransforms(frame)
  root.position.set(rig.position.x, rig.position.y, rig.position.z)
  root.quaternion.set(rig.quaternion.x, rig.quaternion.y, rig.quaternion.z, rig.quaternion.w)
  for (const posedModel of [model, detail, low]) {
    if (!posedModel) continue
    for (const { node, rest, name } of posedModel.joints) {
      const q = rig.joints[name]
      node.quaternion.copy(rest).multiply(turn.set(q.x, q.y, q.z, q.w))
    }
    for (const [name, value] of Object.entries(props.joints ?? {})) {
      const joint = posedModel.jointed.get(name)
      if (!joint) continue
      joint.node.quaternion
        .copy(joint.rest)
        .multiply(turn.setFromAxisAngle(joint.axis, value - joint.baked))
    }
    aimAll(posedModel)
  }
}

function paint(object: Object3D, fill: Material): void {
  object.traverse((child) => {
    if ((child as Mesh).isMesh) (child as Mesh).material = fill
  })
}

/** Draws the JPL model `object` in place of the current rover, or the procedural one without it. */
function showModel(object: Object3D | undefined): void {
  if (model) root.remove(model.object)
  model = object && posed(object)
  placeholder.visible = !object && !detail
  if (object) {
    if (props.ghost) paint(object, material)
    else {
      object.traverse((child) => {
        child.receiveShadow = true
      })
      applyEnvironment(object, props.environment)
      const turret = object.getObjectByName('turret')
      const beam = turret?.userData.beam as [number, number, number] | undefined
      if (turret && beam) hangLamp(turret, new Vector3(), new Vector3(...beam))
    }
    root.add(object)
  } else hangLamp(root, PROCEDURAL_LAMP.at, PROCEDURAL_LAMP.aim)
  applyLod()
  pose(props.frame)
  invalidate()
}

/** Shows the full model or the low-poly one for the camera distance, and who casts the shadow. */
function applyLod(): void {
  if (props.ghost) return
  const caster = !!low
  model?.object.traverse((child) => {
    child.castShadow = !caster
  })
  if (model) model.object.visible = !(far && low)
  if (!low) return
  low.object.visible = !!model
  paint(low.object, far ? lowShade : shadowOnly)
}

if (!props.ghost) {
  loadRoverModel(baseURL, 'ghost')
    .then((loaded) => {
      if (unmounted) return
      const object = loaded.scene.clone()
      object.traverse((child) => {
        child.castShadow = true
        child.receiveShadow = true
      })
      low = posed(object)
      root.add(object)
      applyLod()
      pose(props.frame)
      invalidate()
    })
    .catch((error: unknown) => {
      // The full model casts its own shadow and stays at any distance.
      console.warn('RoverModel: the low-poly model did not load.', error)
    })

  onBeforeRender(() => {
    const cam = camera.value
    const limit = props.lodDistanceM
    if (!cam || !low || !model) return
    const distance = cam.position.distanceTo(root.position)
    const next = limit !== null && distance > limit * (far ? 1 - LOD_MARGIN : 1)
    if (next === far) return
    far = next
    applyLod()
    invalidate()
  })
}

watch(
  () => props.environment,
  (environment) => {
    if (model && !props.ghost) applyEnvironment(model.object, environment)
  },
)

/* The full model: the rover's own, or a focused ghost's. At most two exist per scene. */

const ledgerId = `${props.ghost ? 'ghost' : 'rover'}:${nextModelId()}`
let holding = false
/**
 * A focused ghost's full model: tinted and shaded, faded in over its silhouette, each of the
 * model's materials by its own tinted copy so its textures read through the red.
 */
const detailMaterials = new Map<Material, MeshLambertMaterial>()
let detailOpacity = 0
function tinted(source: Material): MeshLambertMaterial {
  let copy = detailMaterials.get(source)
  if (!copy) {
    copy = new MeshLambertMaterial({
      color: SCENE_COLORS.death,
      map: (source as MeshLambertMaterial).map ?? null,
      transparent: true,
      opacity: detailOpacity,
      depthWrite: false,
    })
    detailMaterials.set(source, copy)
  }
  return copy
}
function setDetailOpacity(opacity: number): void {
  detailOpacity = opacity
  for (const copy of detailMaterials.values()) copy.opacity = opacity
}
let fade = 0

function stopFade(): void {
  if (fade) cancelAnimationFrame(fade)
  fade = 0
}

/** Crossfades from the silhouette to the full model over {@link CROSSFADE_MS}. */
function fadeIn(): void {
  stopFade()
  const started = performance.now()
  const step = () => {
    const p = Math.min(1, (performance.now() - started) / CROSSFADE_MS)
    setDetailOpacity(GHOST_OPACITY.detailed * p)
    material.opacity = GHOST_OPACITY.silhouette * (1 - p)
    if (model) model.object.visible = p < 1
    invalidate()
    fade = p < 1 ? requestAnimationFrame(step) : 0
  }
  step()
}

async function showDetail(): Promise<void> {
  try {
    const full = await loadRoverModel(baseURL, 'full')
    if (unmounted || !props.detailed || detail) return
    const object = full.scene.clone()
    object.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.material = tinted(mesh.material as Material)
    })
    detail = posed(object)
    placeholder.visible = false
    root.add(object)
    pose(props.frame)
    invalidate()
    fadeIn()
  } catch (error) {
    // The silhouette stays.
    console.warn('RoverModel: the full model did not load for the focused ghost.', error)
    dropDetail()
  }
}

/** Back to the silhouette at once, the full model's slot freed. */
function dropDetail(): void {
  stopFade()
  if (detail) root.remove(detail.object)
  detail = undefined
  material.opacity = GHOST_OPACITY.silhouette
  if (model) model.object.visible = true
  placeholder.visible = !model
  setDetailOpacity(0)
  if (holding) props.ledger?.release(ledgerId)
  holding = false
  invalidate()
}

let unmounted = false

if (props.ghost) {
  watch(
    () => props.detailed,
    (detailed) => {
      if (!detailed) return dropDetail()
      if (holding) return
      const grant = () => {
        holding = true
        void showDetail()
      }
      if (props.ledger) props.ledger.request(ledgerId, grant)
      else grant()
    },
    { immediate: true },
  )
}

watch(
  () => props.variant,
  async (wanted) => {
    if (wanted === 'procedural') {
      showModel(undefined)
      if (!props.ghost && holding) {
        props.ledger?.release(ledgerId)
        holding = false
      }
      emit('ready', { variant: wanted, triangles: proceduralTriangles, loadMs: 0 })
      return
    }
    try {
      if (!props.ghost && !holding) {
        // The rover takes a full model's slot; it waits only if two ghosts somehow hold both.
        await new Promise<void>((granted) =>
          props.ledger ? props.ledger.request(ledgerId, granted) : granted(),
        )
        holding = true
      }
      const loaded = await loadRoverModel(baseURL, props.ghost ? 'ghost' : 'full')
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
watch(
  () => props.joints,
  () => pose(props.frame),
  { deep: true },
)

onBeforeUnmount(() => {
  unmounted = true
  stopFade()
  if (holding) props.ledger?.release(ledgerId)
  // Only this rover's own resources: the loaded models' are shared by every rover on the page.
  boxes.dispose()
  cylinders.dispose()
  unitBox.dispose()
  unitCylinder.dispose()
  material.dispose()
  for (const copy of detailMaterials.values()) copy.dispose()
  shadowOnly.dispose()
  lowShade.dispose()
  turretLamp?.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
