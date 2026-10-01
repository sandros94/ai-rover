<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, shallowRef } from 'vue'
import { useRoute } from '#imports'
import { createTerrainSampler } from '#shared/utils/client'
import { chunksFromGrid, sunCrossings, sunPosition } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import { DEFAULT_ROVER_GEOMETRY, poseOnTerrain } from '#shared/utils/rover'
import type { Chunk } from '#shared/utils/terrain'
import type { DiskWire } from '../../shared/disk-wire'
import { decodeDiskWire } from '../../shared/disk-wire'
import WheelTracks from '../components/og/WheelTracks.vue'

/**
 * The staged still behind the social card (`scripts/og-image.ts`): the rover from behind at a
 * person's eye height, driving towards the setting sun over its own tracks. Everything is set
 * from the query, so a capture is repeatable:
 *
 * - `seed`, `x`, `y`: the dev world and where the rover stands (`mars`, 180, -120: a ridge on
 *   the horizon ahead).
 * - `sol`: time of the sol; by default shortly before sunset.
 * - `yaw`: degrees the rover's heading turns left of the sun, so the body does not hide it.
 * - `back`, `side`, `eye`: the camera, metres behind the rover, to its left, and above the ground.
 * - `tracks`, `bend`: metres of tracks behind it, and their turn in degrees per 10 m.
 *
 * `data-og-ready` is set on the root element once the full rover model is drawn and has settled.
 */
const STOP_SCENE = defineAsyncComponent(
  () =>
    // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
    import('~/components/scene/StopScene.vue'),
)

/** The dev world's default chunk: 64 cells of 1 m. */
const CHUNK_VERTICES = 65
/** Ground surveyed around the rover, metres: far enough for the haze to swallow its edge. */
const RADIUS_M = 800
/** Sol fraction the default still is taken at, before sunset. */
const BEFORE_SUNSET = 0.007
/** Time left for shadows, the sky's reflections and the exposure to settle, milliseconds. */
const SETTLE_MS = 2000
const RAD = Math.PI / 180

const route = useRoute()
function query(name: string, fallback: number): number {
  const raw = route.query[name]
  const value = Number(raw)
  return typeof raw === 'string' && raw !== '' && Number.isFinite(value) ? value : fallback
}
const seed = typeof route.query.seed === 'string' ? route.query.seed : 'mars'
const at = { x: query('x', 180), y: query('y', -120) }
const sol = query('sol', sunCrossings().set - BEFORE_SUNSET)
const yawRad = query('yaw', 14) * RAD
const camera = { back: query('back', 7), side: query('side', 0.6), eye: query('eye', 1.7) }
const tracksM = query('tracks', 60)
const bendRad = (query('bend', 5) * RAD) / 10

const disk = shallowRef<DiskWire>()
const error = shallowRef<string>()
onMounted(async () => {
  try {
    disk.value = decodeDiskWire(
      await $fetch<ArrayBuffer>('/api/_dev/disk', {
        query: { seed, x: at.x, y: at.y, radius: RADIUS_M },
        responseType: 'arrayBuffer',
      }),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
})

const chunks = computed(() =>
  disk.value ? chunksFromGrid(disk.value.grid, disk.value.origin, CHUNK_VERTICES) : [],
)
const heightRange = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const h of disk.value?.grid.heights ?? []) {
    if (Number.isNaN(h)) continue
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
  return min <= max ? { min, max } : { min: 0, max: 1 }
})
const heightAt = computed(() => {
  const byKey = new Map<string, Chunk>()
  for (const { chunk } of chunks.value) {
    byKey.set(`${chunk.cx},${chunk.cy}`, { ...chunk, masks: new Uint8Array(chunk.heights.length) })
  }
  const sampler = createTerrainSampler({
    geometry: { vertexCount: CHUNK_VERTICES, cellSize: disk.value?.grid.cellSize ?? 1 },
    peek: (cx, cy) => byKey.get(`${cx},${cy}`),
  })
  return (x: number, y: number) => sampler.heightAt(x, y)
})
const ground = (x: number, y: number) => heightAt.value(x, y) ?? 0

/** Towards the sun's azimuth (clockwise from north), turned `yaw` to the left. */
const headingRad = Math.PI / 2 - sunPosition(sol).azimuthDeg * RAD + yawRad
const forward = { x: Math.cos(headingRad), y: Math.sin(headingRad) }

/** The rover standing on the ground, as a keyframe the scene draws. */
const frame = computed(() => {
  const out = new Float32Array(KEYFRAME_STRIDE)
  if (!disk.value) return out
  const pose = poseOnTerrain(ground, { ...at, headingRad })
  const set = (name: (typeof KEYFRAME_FIELDS)[number], value: number) => {
    out[KEYFRAME_FIELDS.indexOf(name)] = value
  }
  const { position, quaternion } = pose
  set('x', position.x)
  set('y', position.y)
  set('z', position.z)
  set('qx', quaternion.x)
  set('qy', quaternion.y)
  set('qz', quaternion.z)
  set('qw', quaternion.w)
  set('rockerL', pose.rocker.left)
  set('rockerR', pose.rocker.right)
  set('bogieL', pose.bogie.left)
  set('bogieR', pose.bogie.right)
  return out
})

/** The camera at eye height behind the rover, from the rover's middle, which it looks at. */
const cameraOffset = computed((): [number, number, number] => {
  const eye = {
    x: at.x - forward.x * camera.back - forward.y * camera.side,
    y: at.y - forward.y * camera.back + forward.x * camera.side,
  }
  const target = frame.value[KEYFRAME_FIELDS.indexOf('z')]! + 1
  return [eye.x - at.x, eye.y - at.y, ground(eye.x, eye.y) + camera.eye - target]
})

/**
 * The way here, oldest point first: up to the front axle, as far as the wheels have rolled,
 * straight under the rover and bending away behind it.
 */
const tracks = computed(() => {
  const front = DEFAULT_ROVER_GEOMETRY.frontWheel.x
  const points = [{ x: at.x + forward.x * front, y: at.y + forward.y * front }, { ...at }]
  let heading = headingRad
  for (let s = 1; s <= tracksM; s++) {
    if (s > 4) heading += bendRad
    const last = points[points.length - 1]!
    points.push({ x: last.x - Math.cos(heading), y: last.y - Math.sin(heading) })
  }
  return points.reverse()
})

function onRoverStatus(status: string): void {
  if (status !== 'full') return
  setTimeout(() => {
    document.documentElement.dataset.ogReady = ''
  }, SETTLE_MS)
}
</script>

<template>
  <div class="fixed inset-0 bg-black">
    <p v-if="error" class="p-4 text-error">{{ error }}</p>
    <ClientOnly v-else-if="disk">
      <component
        :is="STOP_SCENE"
        class="h-full w-full"
        :frame="frame"
        :chunks="chunks"
        :height-range="heightRange"
        :height-at="heightAt"
        :sol-fraction="sol"
        :camera-offset="cameraOffset"
        @rover-status="onRoverStatus"
      >
        <WheelTracks :path="tracks" :ground="disk" />
      </component>
    </ClientOnly>
  </div>
</template>
