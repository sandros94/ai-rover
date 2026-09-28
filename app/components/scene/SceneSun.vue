<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import { DirectionalLight, HemisphereLight, Matrix4, Vector3 } from 'three'
import type { SkyLighting } from '#shared/utils/client/scene'

const props = withDefaults(
  defineProps<{
    /** Unit vector towards the sun, world x east, y north, z up. */
    direction: { x: number; y: number; z: number }
    lighting: SkyLighting
    /** What the camera looks at: shadows are drawn around it. */
    target: { x: number; y: number; z: number }
    /** Exposure offset in stops over the automatic exposure: +1 doubles it. */
    exposureBias?: number
  }>(),
  { exposureBias: 0 },
)

/**
 * The sun, the sky's fill and the camera's exposure. three.js divides Lambert light by π, so
 * irradiance 1 is intensity π and a surface in full sun shows its albedo. A directional light
 * shines from its position towards its target, both placed here each frame around `target`.
 */
const sun = new DirectionalLight()
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
// Slope-scaled along the normal: grazing sun on gentle ground is where acne starts.
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 0.04
// The shadow camera's up is the snapping frame's below, so texels line up with the snap.
sun.shadow.camera.up.set(0, 0, 1)
const sky = new HemisphereLight()
// three's hemisphere points +y up; the scene is z-up.
sky.position.set(0, 0, 1)

/** Distance from the shadow centre to the light, and the depth the shadow camera spans, metres. */
const SUN_DISTANCE_M = 200
/**
 * Half the side of the shadowed square: at least 30 m around the target, growing with the camera
 * distance so a zoomed-out view keeps its shadows, in steps so the map does not rescale on
 * every wheel tick, and capped so a texel stays under 12 cm.
 */
const SHADOW_HALF_MIN_M = 30
const SHADOW_HALF_MAX_M = 120
const SHADOW_STEP = 1.25
/** Seconds the exposure takes to cover about two thirds of a change: the eye adapting. */
const EXPOSURE_TAU_S = 1.5

function shadowHalf(cameraDistance: number): number {
  const wanted = Math.max(1, (cameraDistance * 1.2) / SHADOW_HALF_MIN_M)
  const steps = Math.ceil(Math.log(wanted) / Math.log(SHADOW_STEP) - 1e-9)
  return Math.min(SHADOW_HALF_MAX_M, SHADOW_HALF_MIN_M * SHADOW_STEP ** steps)
}

/**
 * Sizes the shadow camera to a square of half side `half`. Tres applies bound
 * `shadow-camera-*` values on the first render only, and three reads the frustum from the
 * projection matrix, so a resize at runtime must update the matrix by hand.
 */
function fitShadow(half: number): void {
  const camera = sun.shadow.camera
  camera.left = -half
  camera.right = half
  camera.top = half
  camera.bottom = -half
  camera.near = 1
  camera.far = 2 * SUN_DISTANCE_M
  camera.updateProjectionMatrix()
}
let half = SHADOW_HALF_MIN_M
fitShadow(half)

watchEffect(() => {
  const { lighting } = props
  sun.color.set(lighting.sun.color)
  sun.intensity = lighting.sun.intensity * Math.PI
  sun.shadow.radius = lighting.shadowRadius
  sky.color.set(lighting.sky.color)
  sky.groundColor.set(lighting.ground)
  sky.intensity = lighting.sky.intensity * Math.PI
})

const { renderer, camera } = useTres()
const { onBeforeRender } = useLoop()
const toSun = new Vector3()
const centre = new Vector3()
const lightView = new Matrix4()
const lightViewInverse = new Matrix4()
const UP = new Vector3(0, 0, 1)
const ORIGIN = new Vector3()
let exposure: number | undefined

onBeforeRender(({ delta }) => {
  toSun.set(props.direction.x, props.direction.y, props.direction.z).normalize()
  const cam = camera.value
  const distance = cam
    ? cam.position.distanceTo(centre.set(props.target.x, props.target.y, props.target.z))
    : 0
  const wanted = shadowHalf(distance)
  if (wanted !== half) fitShadow((half = wanted))

  // Snap the centre to whole shadow texels across the light's view, so shadow edges hold still
  // while the rover and camera move instead of crawling a texel at a time.
  lightView.lookAt(toSun, ORIGIN, UP)
  lightViewInverse.copy(lightView).invert()
  centre.set(props.target.x, props.target.y, props.target.z).applyMatrix4(lightViewInverse)
  const texel = (2 * half) / sun.shadow.mapSize.x
  centre.x = Math.round(centre.x / texel) * texel
  centre.y = Math.round(centre.y / texel) * texel
  centre.applyMatrix4(lightView)
  sun.target.position.copy(centre)
  sun.position.copy(centre).addScaledVector(toSun, SUN_DISTANCE_M)
  sun.target.updateMatrixWorld()

  const goal = props.lighting.exposure * 2 ** props.exposureBias
  exposure =
    exposure === undefined
      ? goal
      : exposure + (goal - exposure) * (1 - Math.exp(-delta / EXPOSURE_TAU_S))
  renderer.toneMappingExposure = exposure
})

onBeforeUnmount(() => {
  sun.dispose()
  sky.dispose()
})
</script>

<template>
  <primitive :object="sun" />
  <primitive :object="sun.target" />
  <primitive :object="sky" />
</template>
