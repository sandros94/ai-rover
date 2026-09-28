<script lang="ts">
let modelIds = 0
/** A fresh id for a rover's entry in the scene's full-model ledger. */
const nextModelId = () => ++modelIds
</script>

<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { Material, Mesh, Object3D } from 'three'
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
import { loadRoverModel } from '~/utils/rover-model'

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
  }>(),
  {
    geometry: () => DEFAULT_ROVER_GEOMETRY,
    ghost: false,
    detailed: false,
    variant: 'model',
    ledger: undefined,
    lamp: 0,
    lodDistanceM: null,
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
 * The arm turret's white LEDs (WATSON and PIXL's), the only light the rover carries: a short
 * warm pool on the ground below where the stowed turret sits, at the front of the body. The
 * model has no arm, so the lamp stands where it would be. Always in the scene, at zero by day,
 * so switching it never changes the lit shaders.
 */
const LAMP_CANDELA = 1.2
const turretLamp = props.ghost ? undefined : new SpotLight('#ffe8cc', 0, 1.6, Math.PI / 4, 0.7, 2)
if (turretLamp) {
  turretLamp.position.set(1.25, 0, 0.55)
  turretLamp.target.position.set(1.45, 0, 0)
  root.add(turretLamp, turretLamp.target)
  watchEffect(() => (turretLamp.intensity = LAMP_CANDELA * props.lamp))
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
  return { object, joints }
}

function pose(frame: Float32Array): void {
  if (!model && !detail) return place(partsAt(frame), frame)
  const rig = rigTransforms(frame)
  root.position.set(rig.position.x, rig.position.y, rig.position.z)
  root.quaternion.set(rig.quaternion.x, rig.quaternion.y, rig.quaternion.z, rig.quaternion.w)
  for (const posedModel of [model, detail, low]) {
    for (const { node, rest, name } of posedModel?.joints ?? []) {
      const q = rig.joints[name]
      node.quaternion.copy(rest).multiply(turn.set(q.x, q.y, q.z, q.w))
    }
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
    else
      object.traverse((child) => {
        child.receiveShadow = true
      })
    root.add(object)
  }
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

/* The full model: the rover's own, or a focused ghost's. At most two exist per scene. */

const ledgerId = `${props.ghost ? 'ghost' : 'rover'}:${nextModelId()}`
let holding = false
/** A focused ghost's full model: tinted and shaded, faded in over its silhouette. */
const detailMaterial = props.ghost
  ? new MeshLambertMaterial({
      color: SCENE_COLORS.death,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      flatShading: true,
    })
  : undefined
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
    detailMaterial!.opacity = GHOST_OPACITY.detailed * p
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
    // The atlas under the tint, so the full model's detail reads through the red.
    const source = full.scene.getObjectByProperty('isMesh', true) as Mesh | undefined
    detailMaterial!.map = (source?.material as MeshLambertMaterial | undefined)?.map ?? null
    detailMaterial!.needsUpdate = true
    paint(object, detailMaterial!)
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
  if (detailMaterial) detailMaterial.opacity = 0
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
  detailMaterial?.dispose()
  shadowOnly.dispose()
  lowShade.dispose()
  turretLamp?.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
