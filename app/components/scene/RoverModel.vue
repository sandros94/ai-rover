<script lang="ts">
import type { Material } from 'three'
import { MeshLambertMaterial } from 'three'
import { SCENE_COLORS } from '#shared/utils/client/scene'

let modelIds = 0
/** A fresh id for a rover's entry in the scene's full-model ledger. */
const nextModelId = () => ++modelIds

/** A focused ghost's full model is shaded, and more opaque than its silhouette. */
const DETAIL_OPACITY = 0.7
/**
 * A focused ghost's full model draws each of the model's materials by a red copy, so its textures
 * read through the tint; one copy per material, shared by whichever ghost is focused.
 */
const tints = new WeakMap<Material, MeshLambertMaterial>()
function tinted(source: Material): MeshLambertMaterial {
  let copy = tints.get(source)
  if (!copy) {
    copy = new MeshLambertMaterial({
      color: SCENE_COLORS.death,
      map: (source as MeshLambertMaterial).map ?? null,
      transparent: true,
      opacity: DETAIL_OPACITY,
      depthWrite: false,
    })
    tints.set(source, copy)
  }
  return copy
}
</script>

<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { Mesh, Object3D, Texture } from 'three'
import { Group, SpotLight } from 'three'
import type { FullModelLedger } from '#shared/utils/client/scene'
import { framePlacement } from '#shared/utils/client/scene'
import { applyRoverLook, applyShadowCaster } from '#shared/utils/client/scene/rover-looks'
import type { LoadedRoverModel, RoverModelStatus } from '~/utils/rover-model'
import { applyEnvironment, loadRoverModel } from '~/utils/rover-model'
import type { PosableRover } from '~/utils/rover-pose'
import { posableRover, poseRover } from '~/utils/rover-pose'

const props = withDefaults(
  defineProps<{
    /** The 23 keyframe values: position, attitude, spins, suspension and steering, used as recorded. */
    frame: Float32Array
    /**
     * Draw as a red translucent silhouette, for a death marker: the low-poly model in the ghost
     * look, which gains the full model while `detailed`. Otherwise the rover: the low-poly model
     * as its stand-in until the full model is decoded, and in its place beyond `lodDistanceM`.
     */
    ghost?: boolean
    /** A ghost in focus: the full model crossfades in over the silhouette once decoded. */
    detailed?: boolean
    /** Who may draw a full model in this scene; without one, nobody waits. */
    ledger?: FullModelLedger
    /** Brightness of the arm turret's white LEDs, 0 off to 1 full; the rover's only lamp. */
    lamp?: number
    /** What the model's metals and glass reflect; see `SceneEnvironment`. */
    environment?: Texture | null
    /**
     * URDF joint values, radians, by model node name, over the keyframe's: any node carrying a
     * joint (steering, mast, arm, or a rig joint) turned by hand.
     */
    joints?: Readonly<Record<string, number>>
    /**
     * Camera distance beyond which the rover draws its low-poly model, in the stand-in look, in
     * place of the full one, metres; `null` never. Not for a ghost.
     */
    lodDistanceM?: number | null
    /** Whether the rover casts a shadow; without, neither of its models is a caster. */
    shadows?: boolean
  }>(),
  {
    ghost: false,
    detailed: false,
    ledger: undefined,
    lamp: 0,
    environment: null,
    joints: undefined,
    lodDistanceM: null,
    shadows: true,
  },
)

const emit = defineEmits<{
  /** The rover's model changed (a ghost never emits it); see `RoverModelStatus`. */
  status: [status: RoverModelStatus]
}>()

const baseURL = useRuntimeConfig().app.baseURL
/** The scene is drawn on demand: every change below that shows asks for a frame. */
const { camera, invalidate } = useTres()
const { onBeforeRender } = useLoop()

const root = new Group()
/**
 * The low-poly model: a ghost's silhouette; for the rover, its stand-in, or its shadow caster
 * while the full model is drawn.
 */
let base: PosableRover | undefined
/** The full model: the rover's own, or a focused ghost's, tinted. */
let full: PosableRover | undefined

/**
 * The arm turret's white LEDs around the WATSON camera, the only light the rover carries. It
 * hangs from the drawn model's `turret` node, at the lens and along the camera's boresight
 * (`extras.beam`), so the cone follows the arm: at night the arm holds the turret up over the
 * front deck, lighting the ground a few metres ahead of the wheels. Always in the scene, dark
 * while no model is drawn and at zero by day, so switching it never changes the lit shaders.
 */
const LAMP = {
  candela: 15,
  /** Reach, metres: past the lit patch, which lies about 4.5 m from the raised turret. */
  range: 9,
  /** Half-angle of the cone, radians, and its soft edge. */
  angle: 0.42,
  penumbra: 0.6,
}
const turretLamp = props.ghost
  ? undefined
  : new SpotLight('#ffe8cc', 0, LAMP.range, LAMP.angle, LAMP.penumbra, 2)
const drawn = shallowRef(false)
if (turretLamp) {
  root.add(turretLamp, turretLamp.target)
  watchEffect(() => {
    turretLamp.intensity = drawn.value ? LAMP.candela * props.lamp : 0
    invalidate()
  })
}

/** Hangs the lamp from `rover`'s turret, at the lens, aimed along WATSON's boresight. */
function hangLamp(rover: PosableRover): void {
  const turret = rover.object.getObjectByName('turret')
  const beam = turret?.userData.beam as [number, number, number] | undefined
  if (!turretLamp || !turret || !beam) return
  turret.add(turretLamp, turretLamp.target)
  turretLamp.position.set(0, 0, 0)
  turretLamp.target.position.set(...beam)
}

function pose(frame: Float32Array): void {
  const { position, quaternion } = framePlacement(frame)
  root.position.set(position.x, position.y, position.z)
  root.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  for (const rover of [base, full]) if (rover) poseRover(rover, frame, props.joints)
  invalidate()
}

/** A posed copy of `loaded` under the root, dressed before it is first drawn. */
function place(loaded: LoadedRoverModel, dress: (object: Object3D) => void): PosableRover {
  const object = loaded.scene.clone()
  dress(object)
  const rover = posableRover(object)
  root.add(object)
  poseRover(rover, props.frame, props.joints)
  return rover
}

/* Crossfading from the low-poly model to the full one. */

/** How long the full model takes to replace the low-poly one, milliseconds. */
const CROSSFADE_MS = 150

/**
 * Draws `object` through transparent copies of its materials, one per material, until
 * `restore()`: the materials themselves are shared with every other copy of the model, which must
 * not fade with it. Fading in, the copies keep the source's depth writes; fading out, they write
 * none, so the incoming model shows through.
 */
function fading(object: Object3D, incoming: boolean) {
  const copies = new Map<Material, Material>()
  const swapped: { mesh: Mesh; material: Material }[] = []
  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    const material = mesh.material as Material
    let copy = copies.get(material)
    if (!copy) {
      copy = material.clone()
      copy.transparent = true
      if (!incoming) copy.depthWrite = false
      // `clone()` leaves the shader hooks out; the model's metals reflect through them.
      copy.onBeforeCompile = material.onBeforeCompile
      copy.customProgramCacheKey = material.customProgramCacheKey
      copies.set(material, copy)
    }
    mesh.material = copy
    swapped.push({ mesh, material })
  })
  return {
    set(p: number): void {
      for (const [material, copy] of copies) copy.opacity = material.opacity * p
    },
    restore(): void {
      for (const { mesh, material } of swapped) mesh.material = material
      for (const copy of copies.values()) copy.dispose()
    },
  }
}

let fade: { frame: number; restore: () => void } | undefined

/** Ends a crossfade where it stands, both models back on their own materials. */
function stopFade(): void {
  if (!fade) return
  cancelAnimationFrame(fade.frame)
  fade.restore()
  fade = undefined
}

/** Fades `outgoing` out and `incoming` in over {@link CROSSFADE_MS}, then hides `outgoing`. */
function crossfade(outgoing: Object3D, incoming: Object3D, done: () => void): void {
  stopFade()
  const from = fading(outgoing, false)
  const to = fading(incoming, true)
  const started = performance.now()
  const current = {
    frame: 0,
    restore: () => {
      from.restore()
      to.restore()
    },
  }
  fade = current
  const step = () => {
    const p = Math.min(1, (performance.now() - started) / CROSSFADE_MS)
    from.set(1 - p)
    to.set(p)
    invalidate()
    if (p < 1) {
      current.frame = requestAnimationFrame(step)
      return
    }
    stopFade()
    outgoing.visible = false
    done()
  }
  step()
}

/* Which of the rover's two models is drawn. */

/** Whether the camera is beyond `lodDistanceM`. */
let far = false
/** How much nearer than `lodDistanceM` the camera must come back for the full model. */
const LOD_MARGIN = 0.1

/**
 * Draws the rover's full model once it is in and the camera is within `lodDistanceM`, else the
 * low-poly model in the stand-in look. While the full model is drawn the low-poly one stays as its
 * shadow caster, and the full model casts none; without a low-poly model the full one casts its
 * own shadow and is drawn at any distance. Without `shadows` nothing casts, and the low-poly model
 * is hidden while the full one is drawn. The lamp hangs from whichever is drawn: a light under a
 * hidden node is dark.
 */
function showRover(): void {
  const detailed = !!full && !(far && base)
  if (full) {
    full.object.visible = detailed
    const casts = !base && props.shadows
    full.object.traverse((child) => (child.castShadow = casts))
  }
  if (base) {
    base.object.visible = !detailed || props.shadows
    if (detailed) applyShadowCaster(base.object)
    else applyRoverLook(base.object, 'standin')
    if (!props.shadows) base.object.traverse((child) => (child.castShadow = false))
  }
  const lit = detailed ? full : base
  if (lit) {
    hangLamp(lit)
    drawn.value = true
  }
  invalidate()
}

/**
 * The rover's full model is in: it crossfades in over the stand-in when that is drawn and the
 * camera is near, else it takes its place at once.
 */
function arriveFull(rover: PosableRover): void {
  full = rover
  if (base?.object.visible && !far) {
    // Drawn through the fade, shown by `showRover` once it ends.
    crossfade(base.object, rover.object, showRover)
  } else showRover()
}

/** A focused ghost's full model is in: it crossfades in over the silhouette when that is drawn. */
function arriveDetail(rover: PosableRover): void {
  full = rover
  if (base?.object.visible) crossfade(base.object, rover.object, () => {})
  else invalidate()
}

/* The low-poly model. */

let unmounted = false

loadRoverModel(baseURL, 'low-poly')
  .then((loaded) => {
    if (unmounted) return
    base = place(loaded, (object) => applyRoverLook(object, props.ghost ? 'ghost' : 'standin'))
    if (!props.ghost) {
      if (!full) emit('status', 'standin')
      showRover()
    } else if (full) {
      // A focused ghost's full model came first: the silhouette waits hidden for the unfocus.
      base.object.visible = false
    } else invalidate()
  })
  .catch((error: unknown) => {
    if (unmounted || full) return
    console.warn('RoverModel: the low-poly rover model did not load.', error)
    if (!props.ghost) emit('status', 'unavailable')
  })

/* The full model: the rover's own, or a focused ghost's. At most two exist per scene. */

const ledgerId = `${props.ghost ? 'ghost' : 'rover'}:${nextModelId()}`
let holding = false

/** Frees the full model's slot, or withdraws the request still waiting for one. */
function release(): void {
  props.ledger?.release(ledgerId)
  holding = false
}

/** Waits for a full model's slot, then loads the full model. */
async function loadFull(): Promise<LoadedRoverModel> {
  if (!holding) {
    await new Promise<void>((granted) =>
      props.ledger ? props.ledger.request(ledgerId, granted) : granted(),
    )
    holding = true
  }
  return loadRoverModel(baseURL, 'full')
}

if (!props.ghost) {
  loadFull()
    .then((loaded) => {
      if (unmounted) return
      const rover = place(loaded, (object) => {
        // The stand-in casts the shadow through the crossfade; `showRover` settles who casts.
        object.traverse((child) => {
          child.castShadow = false
          child.receiveShadow = true
        })
        applyEnvironment(object, props.environment)
      })
      emit('status', 'full')
      arriveFull(rover)
    })
    .catch((error: unknown) => {
      if (unmounted) return
      // The stand-in stays; the slot goes to a ghost.
      console.warn('RoverModel: the full rover model did not load; the stand-in stays.', error)
      release()
    })
} else {
  watch(
    () => props.detailed,
    (detailed) => {
      if (!detailed) return dropDetail()
      if (holding) return
      loadFull()
        .then((loaded) => {
          if (unmounted || !props.detailed || full) return
          arriveDetail(
            place(loaded, (object) =>
              object.traverse((child) => {
                const mesh = child as Mesh
                if (mesh.isMesh) mesh.material = tinted(mesh.material as Material)
              }),
            ),
          )
        })
        .catch((error: unknown) => {
          // The silhouette stays.
          console.warn('RoverModel: the full model did not load for the focused ghost.', error)
          dropDetail()
        })
    },
    { immediate: true },
  )
}

/** Back to a ghost's silhouette at once, the full model's slot freed. */
function dropDetail(): void {
  stopFade()
  if (full) root.remove(full.object)
  full = undefined
  if (base) base.object.visible = true
  release()
  invalidate()
}

watch(() => props.frame, pose)
watch(
  () => props.joints,
  () => pose(props.frame),
  { deep: true },
)
watch(
  () => props.environment,
  (environment) => {
    if (full && !props.ghost) applyEnvironment(full.object, environment)
    invalidate()
  },
)
watch(
  () => props.shadows,
  () => {
    if (props.ghost || !(base || full)) return
    stopFade()
    showRover()
  },
)
pose(props.frame)

if (!props.ghost) {
  onBeforeRender(() => {
    const cam = camera.value
    const limit = props.lodDistanceM
    if (!cam || !full || !base) return
    const distance = cam.position.distanceTo(root.position)
    const next = limit !== null && distance > limit * (far ? 1 - LOD_MARGIN : 1)
    if (next === far) return
    far = next
    stopFade()
    showRover()
  })
}

onBeforeUnmount(() => {
  unmounted = true
  stopFade()
  release()
  // Only this rover's own resources: materials and geometry are shared by every copy on the page.
  turretLamp?.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
