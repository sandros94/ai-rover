<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import { DirectionalLight, HemisphereLight, Vector3 } from 'three'
import type { SkyLighting } from '#shared/utils/client/scene'
import { heldSunDirection, shadowHalf, snapShadowCentre } from '#shared/utils/client/scene'

const props = withDefaults(
  defineProps<{
    /** Unit vector towards the sun, world x east, y north, z up. */
    direction: { x: number; y: number; z: number }
    lighting: SkyLighting
    /** What the camera looks at: shadows are drawn around it. */
    target: { x: number; y: number; z: number }
    /** Exposure offset in stops over the automatic exposure: +1 doubles it. */
    exposureBias?: number
    /** Whether the sun casts shadows at all. */
    shadows?: boolean
    /** Side of the square shadow map, texels. */
    shadowMapSize?: number
  }>(),
  { exposureBias: 0, shadows: true, shadowMapSize: 2048 },
)

/**
 * The sun, the sky's fill and the camera's exposure. three.js divides Lambert light by π, so
 * irradiance 1 is intensity π and a surface in full sun shows its albedo. A directional light
 * shines from its position towards its target, both placed each frame around `target`.
 */
const sun = new DirectionalLight()
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
/** Seconds the exposure takes to cover about two thirds of a change: the eye adapting. */
const EXPOSURE_TAU_S = 1.5
/** Relative distance from its goal at which the exposure is taken as settled and drawn no more. */
const EXPOSURE_SETTLED = 1e-3

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
let half = shadowHalf(0)
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
watchEffect(() => (sun.castShadow = props.shadows))
watch(
  () => props.shadowMapSize,
  (size) => {
    sun.shadow.mapSize.set(size, size)
    // three allocates the map at the size it finds when none exists.
    sun.shadow.map?.dispose()
    sun.shadow.map = null
  },
  { immediate: true },
)

const { renderer, camera, invalidate } = useTres()
const { onBeforeRender } = useLoop()
const toSun = new Vector3()
let held: { x: number; y: number; z: number } | undefined
let exposure: number | undefined

onBeforeRender(({ delta }) => {
  // The light turns in steps the eye cannot see between: each turn redraws every shadow edge.
  held = heldSunDirection(held, props.direction)
  toSun.set(held.x, held.y, held.z).normalize()
  const cam = camera.value
  const { x, y, z } = props.target
  const distance = cam ? Math.hypot(cam.position.x - x, cam.position.y - y, cam.position.z - z) : 0
  const wanted = shadowHalf(distance, half)
  if (wanted !== half) fitShadow((half = wanted))

  const centre = snapShadowCentre(props.target, toSun, (2 * half) / sun.shadow.mapSize.x)
  sun.target.position.set(centre.x, centre.y, centre.z)
  sun.position.copy(sun.target.position).addScaledVector(toSun, SUN_DISTANCE_M)
  sun.target.updateMatrixWorld()

  const goal = props.lighting.exposure * 2 ** props.exposureBias
  if (exposure === undefined || Math.abs(goal - exposure) <= goal * EXPOSURE_SETTLED)
    exposure = goal
  else {
    exposure += (goal - exposure) * (1 - Math.exp(-delta / EXPOSURE_TAU_S))
    invalidate()
  }
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
