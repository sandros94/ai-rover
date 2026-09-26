<script setup lang="ts">
import { KEYFRAME_FIELDS } from '#shared/utils/drive'

const props = defineProps<{ segmentId: string; serverOffsetMs: number }>()

const emit = defineEmits<{
  pose: [pose: { x: number; y: number; headingRad: number }]
  plan: [polyline: { x: number; y: number }[]]
}>()

/** Pose updates per second passed up: the map needs no more to move a marker smoothly. */
const POSE_HZ = 4

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const QX = KEYFRAME_FIELDS.indexOf('qx')
const QY = KEYFRAME_FIELDS.indexOf('qy')
const QZ = KEYFRAME_FIELDS.indexOf('qz')
const QW = KEYFRAME_FIELDS.indexOf('qw')

const { frame, manifest } = useSegmentPlayback(props.segmentId, {
  serverOffsetMs: () => props.serverOffsetMs,
})

let last = 0
watch(frame, (f) => {
  if (!f || performance.now() - last < 1000 / POSE_HZ) return
  last = performance.now()
  const [x, y, z, w] = [f[QX]!, f[QY]!, f[QZ]!, f[QW]!]
  // Yaw of the world-from-body quaternion Rz(heading) · Ry(pitch) · Rx(roll).
  const headingRad = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  emit('pose', { x: f[X]!, y: f[Y]!, headingRad })
})
watch(manifest, (m) => {
  if (m) emit('plan', m.plan.polyline)
})
</script>

<template>
  <span hidden />
</template>
