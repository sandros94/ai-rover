<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { PerspectiveCamera } from 'three'
import { Vector3 } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const props = withDefaults(
  defineProps<{
    /** The point orbited and followed: the rover, in world metres. */
    target: { x: number; y: number; z: number }
    /** Camera offset from the target when the scene opens, world metres. */
    offset?: [number, number, number]
    minDistance?: number
    maxDistance?: number
  }>(),
  { offset: () => [-9, -9, 6], minDistance: 3, maxDistance: 160 },
)

/** The scene is z-up like the terrain data, so no axis swap anywhere. */
const UP = new Vector3(0, 0, 1)
const camera = shallowRef<PerspectiveCamera>()
const { renderer } = useTres()
const { onBeforeRender } = useLoop()
const goal = new Vector3()
let controls: OrbitControls | undefined

watch(
  camera,
  (cam) => {
    if (!cam || controls) return
    const { x, y, z } = props.target
    const [ox, oy, oz] = props.offset
    cam.position.set(x + ox, y + oy, z + oz)
    // OrbitControls reads the camera's up once, here: it orbits about world z.
    controls = new OrbitControls(cam, renderer.domElement)
    controls.target.set(x, y, z)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = props.minDistance
    controls.maxDistance = props.maxDistance
    // Keep the eye above the horizon plane of the target.
    controls.maxPolarAngle = Math.PI / 2 - 0.05
    controls.update()
  },
  { immediate: true },
)

onBeforeRender(() => {
  if (!controls || !camera.value) return
  goal.set(props.target.x, props.target.y, props.target.z)
  // Carry the camera with the target so the orbit offset the user chose is kept.
  camera.value.position.add(goal).sub(controls.target)
  controls.target.copy(goal)
  controls.update()
})

onBeforeUnmount(() => controls?.dispose())
</script>

<template>
  <TresPerspectiveCamera ref="camera" :up="UP" :fov="50" :near="0.1" :far="3000" />
</template>
