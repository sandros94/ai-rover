<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three'
import type { SkyLighting } from '#shared/utils/client/scene'

const props = defineProps<{
  /** Unit vector towards the sun, world x east, y north, z up. */
  direction: { x: number; y: number; z: number }
  /** The sky's colours; its horizon, the sky at and below the horizon, is the fog's colour. */
  lighting: SkyLighting
}>()

/** Inside the camera's far plane, around the camera wherever it goes. */
const RADIUS_M = 2000
/** Angular radius of the drawn sun disc: about twice Mars' 0.18°, to read on a small screen. */
const DISC_RAD = (0.4 * Math.PI) / 180

const material = new ShaderMaterial({
  side: BackSide,
  depthWrite: false,
  depthTest: false,
  fog: false,
  uniforms: {
    horizon: { value: new Color() },
    zenith: { value: new Color() },
    glow: { value: new Color() },
    sunColor: { value: new Color() },
    toSun: { value: new Vector3() },
    discCos: { value: Math.cos(DISC_RAD) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDirection;
    void main() {
      vDirection = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  // Not tone mapped, like three's fog and clear colour, so the horizon is the fog's colour
  // exactly: the sky colours are what the eye sees, exposure already settled.
  fragmentShader: /* glsl */ `
    uniform vec3 horizon;
    uniform vec3 zenith;
    uniform vec3 glow;
    uniform vec3 sunColor;
    uniform vec3 toSun;
    uniform float discCos;
    varying vec3 vDirection;
    void main() {
      vec3 dir = normalize( vDirection );
      float up = max( dir.z, 0.0 );
      vec3 color = mix( horizon, zenith, pow( up, 0.6 ) );
      float facing = max( dot( dir, toSun ), 0.0 );
      // Forward scattering around the sun, faded in above the horizon so the fog line stays clean.
      float around = pow( facing, 12.0 ) * 0.8 + pow( facing, 3.0 ) * 0.25;
      color = mix( color, glow, clamp( around, 0.0, 1.0 ) * smoothstep( 0.0, 0.08, dir.z ) );
      float disc = smoothstep( discCos - 0.00002, discCos + 0.00002, facing ) * step( 0.0, dir.z );
      color = mix( color, sunColor, disc );
      gl_FragColor = vec4( color, 1.0 );
      #include <colorspace_fragment>
    }
  `,
})
const dome = new Mesh(new SphereGeometry(RADIUS_M, 48, 24), material)
dome.frustumCulled = false
dome.renderOrder = -1

watchEffect(() => {
  const u = material.uniforms
  const { lighting, direction } = props
  u.horizon!.value.set(lighting.horizon)
  u.zenith!.value.set(lighting.zenith)
  u.glow!.value.set(lighting.glow)
  // The disc is its own colour while the sun is up and fades out as it sets.
  u.sunColor!.value.set(lighting.sun.color).lerp(
    u.horizon!.value,
    1 - Math.min(1, lighting.sun.intensity * 5),
  )
  u.toSun!.value.set(direction.x, direction.y, direction.z).normalize()
})

const { camera } = useTres()
const { onBeforeRender } = useLoop()
onBeforeRender(() => {
  const cam = camera.value
  if (cam) dome.position.copy(cam.position)
})

onBeforeUnmount(() => {
  dome.geometry.dispose()
  material.dispose()
})
</script>

<template>
  <primitive :object="dome" />
</template>
