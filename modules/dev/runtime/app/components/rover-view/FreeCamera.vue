<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useLoop, useTres } from '@tresjs/core'
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

type Point = { x: number; y: number; z: number }

/**
 * A free orbit camera, not tied to anything in the scene: it opens at `position` looking at
 * `target` and goes wherever the pointer takes it. Orthographic shows `sizeM` metres from the
 * bottom of the view to the top, with no perspective at all; perspective has a vertical `fovDeg`.
 */
const props = defineProps<{
  orthographic: boolean
  position: Point
  target: Point
  fovDeg: number
  sizeM: number
}>()

const emit = defineEmits<{
  /** The camera moved: where it is, what it looks at, and its field (degrees, or metres tall). */
  pose: [pose: { position: Point; target: Point; fovDeg: number; sizeM: number }]
}>()

const { renderer, sizes } = useTres()
/** The scene is z-up like the terrain data. */
const UP = new Vector3(0, 0, 1)

const camera = props.orthographic
  ? new OrthographicCamera(-1, 1, 1, -1, 0.01, 500)
  : new PerspectiveCamera(props.fovDeg, 1, 0.01, 500)
camera.up.copy(UP)
camera.position.set(props.position.x, props.position.y, props.position.z)
const opening: [number, number, number] = [props.position.x, props.position.y, props.position.z]

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(props.target.x, props.target.y, props.target.z)
controls.enableDamping = true
controls.update()

/** An orthographic frustum in pixels, zoomed to metres: the zoom stays the user's to change. */
let zoomed = false
watch(
  () => [sizes.width.value, sizes.height.value] as const,
  ([width, height]) => {
    if (!(camera instanceof OrthographicCamera) || !width || !height) return
    camera.left = -width / 2
    camera.right = width / 2
    camera.top = height / 2
    camera.bottom = -height / 2
    if (!zoomed) camera.zoom = height / props.sizeM
    zoomed = true
    camera.updateProjectionMatrix()
  },
  { immediate: true },
)

const point = (v: Vector3): Point => ({ x: v.x, y: v.y, z: v.z })
function report(): void {
  emit('pose', {
    position: point(camera.position),
    target: point(controls.target),
    fovDeg: camera instanceof PerspectiveCamera ? camera.fov : props.fovDeg,
    sizeM: camera instanceof OrthographicCamera ? sizes.height.value / camera.zoom : props.sizeM,
  })
}
controls.addEventListener('change', report)
report()

const { onBeforeRender } = useLoop()
onBeforeRender(() => controls.update())
onBeforeUnmount(() => controls.dispose())
</script>

<template>
  <!-- Tres places a camera without a position at (3, 3, 3), so the opening one is passed again. -->
  <primitive :object="camera" :position="opening" />
</template>
