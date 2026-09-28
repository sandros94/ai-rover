<script setup lang="ts">
import { useTres } from '@tresjs/core'
import type { Texture } from 'three'
import {
  Color,
  WebGLRenderer as WebGL,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  PMREMGenerator,
  RGBAFormat,
} from 'three'
import type { SkyLighting } from '#shared/utils/client/scene'

const props = defineProps<{
  /** Unit vector towards the sun, world x east, y north, z up. */
  direction: { x: number; y: number; z: number }
  lighting: SkyLighting
}>()

const emit = defineEmits<{
  /** The environment for the scene's metals and glass to reflect, prefiltered for roughness. */
  change: [environment: Texture | null]
}>()

/**
 * What shiny surfaces reflect: the sky and the ground, in the same light units as `SceneSun`'s
 * lights, so a mirror shows the sky as bright as the hemisphere light makes a white surface.
 * The sky keeps the hues of the drawn dome (horizon to zenith, the glow towards the sun) at the
 * skylight's intensity; the sun's disc itself is left to the directional light's highlight.
 */
const WIDTH = 64
const HEIGHT = 32

const { renderer } = useTres()
if (!(renderer instanceof WebGL)) {
  throw new Error('SceneEnvironment: prefiltering the sky needs the WebGL renderer.')
}
const pmrem = new PMREMGenerator(renderer)
let target: ReturnType<PMREMGenerator['fromEquirectangular']> | undefined
const pixels = new Float32Array(WIDTH * HEIGHT * 4)
const source = new DataTexture(pixels, WIDTH, HEIGHT, RGBAFormat, FloatType)
source.mapping = EquirectangularReflectionMapping
source.magFilter = source.minFilter = LinearFilter
const horizon = new Color()
const zenith = new Color()
const glow = new Color()
const ground = new Color()
const mixed = new Color()

function paint(): void {
  const { lighting, direction } = props
  horizon.set(lighting.horizon)
  zenith.set(lighting.zenith)
  glow.set(lighting.glow)
  ground.set(lighting.ground).multiplyScalar(lighting.sky.intensity)
  const toSun = Math.hypot(direction.x, direction.y, direction.z) || 1
  for (let row = 0; row < HEIGHT; row++) {
    const elevation = ((row + 0.5) / HEIGHT - 0.5) * Math.PI
    for (let col = 0; col < WIDTH; col++) {
      const longitude = ((col + 0.5) / WIDTH - 0.5) * 2 * Math.PI
      // three's equirectangular direction (y up), turned into the scene's (z up) as
      // `ENVIRONMENT_ROTATION` turns it back: scene (x, y, z) = three (x, −z, y).
      const three = {
        x: Math.cos(elevation) * Math.cos(longitude),
        y: Math.sin(elevation),
        z: Math.cos(elevation) * Math.sin(longitude),
      }
      const dir = { x: three.x, y: -three.z, z: three.y }
      if (dir.z > 0) {
        mixed.copy(horizon).lerp(zenith, dir.z ** 0.6)
        const facing = Math.max(
          0,
          (dir.x * direction.x + dir.y * direction.y + dir.z * direction.z) / toSun,
        )
        mixed.lerp(glow, Math.min(1, facing ** 12 * 0.8 + facing ** 3 * 0.25))
        // Hue from the dome, amount from the skylight.
        const peak = Math.max(mixed.r, mixed.g, mixed.b) || 1
        mixed.multiplyScalar(lighting.sky.intensity / peak)
      } else mixed.copy(ground)
      pixels.set([mixed.r, mixed.g, mixed.b, 1], 4 * (row * WIDTH + col))
    }
  }
  source.needsUpdate = true
  const next = pmrem.fromEquirectangular(source)
  emit('change', next.texture)
  target?.dispose()
  target = next
}

// The dome's colours are 8-bit hex strings, so this runs only when the sky visibly changes.
watch(
  () =>
    [
      props.lighting.horizon,
      props.lighting.zenith,
      props.lighting.glow,
      props.lighting.ground,
      props.lighting.sky.intensity.toFixed(3),
      Math.round(Math.atan2(props.direction.y, props.direction.x) * 36),
      Math.round(props.direction.z * 36),
    ].join(),
  paint,
  { immediate: true },
)

onBeforeUnmount(() => {
  emit('change', null)
  target?.dispose()
  source.dispose()
  pmrem.dispose()
})
</script>

<template>
  <slot />
</template>
