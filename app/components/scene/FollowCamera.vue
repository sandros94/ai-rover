<script setup lang="ts">
import { useLoop, useTres } from '@tresjs/core'
import type { PerspectiveCamera } from 'three'
import { Vector3 } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { easeFocus } from '#shared/utils/client'

const props = withDefaults(
  defineProps<{
    /** The point orbited and followed, world metres: the rover, or what is focused. */
    target: { x: number; y: number; z: number }
    /**
     * Changes when the target moves to another object: the camera eases there instead of
     * jumping, then follows it again.
     */
    targetKey?: number
    /** Camera offset from the target when the scene opens, world metres. */
    offset?: [number, number, number]
    minDistance?: number
    maxDistance?: number
  }>(),
  { targetKey: 0, offset: () => [-9, -9, 6], minDistance: 3, maxDistance: 160 },
)

/** The scene is z-up like the terrain data, so no axis swap anywhere. */
const UP = new Vector3(0, 0, 1)
const camera = shallowRef<PerspectiveCamera>()
const { renderer, invalidate } = useTres()
const { onBeforeRender } = useLoop()
const goal = new Vector3()
let controls: OrbitControls | undefined
/** A move onto a new target under way: where it started and when. */
let ease: { from: { x: number; y: number; z: number }; started: number } | undefined

watch(
  () => props.targetKey,
  () => {
    if (!controls) return
    const { x, y, z } = controls.target
    ease = { from: { x, y, z }, started: performance.now() }
  },
)

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
  let { x, y, z } = props.target
  if (ease) {
    const elapsed = performance.now() - ease.started
    ;({ x, y, z } = easeFocus(ease.from, props.target, elapsed))
    if (x === props.target.x && y === props.target.y && z === props.target.z) ease = undefined
  }
  goal.set(x, y, z)
  const carried = !goal.equals(controls.target)
  // Carry the camera with the target so the orbit offset the user chose is kept.
  camera.value.position.add(goal).sub(controls.target)
  controls.target.copy(goal)
  // `update` reports a view that moved; damping left below its threshold is not drawn.
  if (controls.update() || carried) invalidate()
})

onBeforeUnmount(() => controls?.dispose())
</script>

<template>
  <TresPerspectiveCamera ref="camera" :up="UP" :fov="50" :near="0.1" :far="3000" />
</template>
