<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import type { HeightGrid } from '#shared/utils/terrain'
import { DEFAULT_CRATERS, DEFAULT_RELIEF, slopeAt } from '#shared/utils/terrain'
import type { DiskWire } from '../../shared/disk-wire'
import { decodeDiskWire } from '../../shared/disk-wire'

/** Hillshade light: from the north-west (azimuth 315°), 45° above the horizon. */
const LIGHT_ALTITUDE = Math.PI / 4
const LIGHT = {
  x: -Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  y: Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  z: Math.sin(LIGHT_ALTITUDE),
}

interface DiskData extends DiskWire {
  /** Lambert shade in [0, 1] per vertex, NaN where the height is. */
  shade: Float32Array
  minHeight: number
  maxHeight: number
  computeMs: string | null
}

const params = reactive({
  seed: 'mars',
  x: 0,
  y: 0,
  radius: 500,
  amplitude: DEFAULT_RELIEF.amplitude,
  gain: DEFAULT_RELIEF.gain,
  craters: DEFAULT_CRATERS.meanPerCell,
})
const overlays = reactive({ hillshade: true, traversable: true, reachable: false, fog: true })

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const data = shallowRef<DiskData | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const hover = ref<{ i: number; j: number } | null>(null)

async function render(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const response = await $fetch.raw<ArrayBuffer>('/api/_dev/disk', {
      query: { ...params },
      responseType: 'arrayBuffer',
    })
    data.value = parseDisk(response._data!, response.headers.get('x-compute-ms'))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function parseDisk(buffer: ArrayBuffer, computeMs: string | null): DiskData {
  const disk = decodeDiskWire(buffer)
  let minHeight = Infinity
  let maxHeight = -Infinity
  for (const h of disk.grid.heights) {
    if (h < minHeight) minHeight = h
    if (h > maxHeight) maxHeight = h
  }
  return { ...disk, shade: hillshade(disk.grid), minHeight, maxHeight, computeMs }
}

/** Central-difference normals (one-sided at the edges), dotted with the light. */
function hillshade({ heights, width, height, cellSize }: HeightGrid): Float32Array {
  const shade = new Float32Array(width * height)
  for (let j = 0; j < height; j++) {
    const j0 = Math.max(0, j - 1)
    const j1 = Math.min(height - 1, j + 1)
    for (let i = 0; i < width; i++) {
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(width - 1, i + 1)
      const gx = (heights[j * width + i1]! - heights[j * width + i0]!) / ((i1 - i0) * cellSize)
      const gy = (heights[j1 * width + i]! - heights[j0 * width + i]!) / ((j1 - j0) * cellSize)
      const dot = (-gx * LIGHT.x - gy * LIGHT.y + LIGHT.z) / Math.sqrt(gx * gx + gy * gy + 1)
      shade[j * width + i] = Math.max(0, dot)
    }
  }
  return shade
}

function draw(): void {
  const disk = data.value
  const el = canvas.value
  if (!disk || !el) return
  const { width, height, heights } = disk.grid
  el.width = width
  el.height = height
  const context = el.getContext('2d')
  if (!context) return
  const image = context.createImageData(width, height)
  const pixels = image.data
  const span = disk.maxHeight - disk.minHeight || 1
  for (let j = 0; j < height; j++) {
    // Grid rows run south to north; canvas rows run top to bottom.
    const row = (height - 1 - j) * width
    for (let i = 0; i < width; i++) {
      const k = j * width + i
      const p = (row + i) * 4
      const h = heights[k]!
      if (Number.isNaN(h)) continue
      const t = (h - disk.minHeight) / span
      // Mars ochre ramp: dark rust at the lowest ground, pale dust at the highest.
      let r = 90 + 150 * t
      let g = 45 + 125 * t
      let b = 30 + 95 * t
      const shade = disk.shade[k]!
      // Vertices bordering the NaN corners have no normal; leave them unshaded.
      if (overlays.hillshade && !Number.isNaN(shade)) {
        const s = 0.25 + 0.95 * shade
        r *= s
        g *= s
        b *= s
      }
      if (overlays.traversable && !disk.traversable[k]) {
        r = r * 0.45 + 220 * 0.55
        g *= 0.45
        b *= 0.45
      }
      if (overlays.reachable && disk.reachable[k]) {
        r *= 0.6
        g = g * 0.6 + 200 * 0.4
        b = b * 0.6 + 220 * 0.4
      }
      if (overlays.fog && !disk.visible[k]) {
        r *= 0.3
        g *= 0.3
        b *= 0.3
      }
      pixels[p] = r
      pixels[p + 1] = g
      pixels[p + 2] = b
      pixels[p + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)

  const { cellSize } = disk.grid
  const cx = disk.center.x / cellSize - disk.origin.i
  const cy = height - 1 - (disk.center.y / cellSize - disk.origin.j)
  context.strokeStyle = 'rgba(255, 255, 255, 0.8)'
  context.lineWidth = 2
  context.beginPath()
  context.arc(cx, cy, params.radius / cellSize, 0, 2 * Math.PI)
  context.stroke()
  context.fillStyle = 'white'
  context.fillRect(cx - 3, cy - 3, 6, 6)

  // The flood-fill seed: a cyan ring, distinct from the centre square when the two differ.
  const sx = disk.reachableFrom.i
  const sy = height - 1 - disk.reachableFrom.j
  context.strokeStyle = 'rgb(80, 220, 240)'
  context.lineWidth = 2
  context.beginPath()
  context.arc(sx, sy, 5, 0, 2 * Math.PI)
  context.stroke()
}

watch([data, overlays], draw, { flush: 'post' })

function onPointerMove(event: PointerEvent): void {
  const disk = data.value
  const el = canvas.value
  if (!disk || !el) return
  const rect = el.getBoundingClientRect()
  const i = Math.floor(((event.clientX - rect.left) / rect.width) * disk.grid.width)
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * disk.grid.height)
  const j = disk.grid.height - 1 - row
  hover.value = i >= 0 && i < disk.grid.width && j >= 0 && j < disk.grid.height ? { i, j } : null
}

const readout = computed(() => {
  const disk = data.value
  const cell = hover.value
  if (!disk || !cell) return null
  const { cellSize, width } = disk.grid
  const k = cell.j * width + cell.i
  const slope = (Math.atan(slopeAt(disk.grid, cell)) * 180) / Math.PI
  return {
    x: (disk.origin.i + cell.i) * cellSize,
    y: (disk.origin.j + cell.j) * cellSize,
    height: disk.grid.heights[k]!,
    slope,
    flags: [
      disk.traversable[k] ? 'traversable' : 'blocked',
      disk.reachable[k] ? 'reachable' : null,
      disk.visible[k] ? 'visible' : 'fogged',
    ]
      .filter(Boolean)
      .join(', '),
  }
})

/** Percentages are over vertices with a height; bounding-box corners outside every chunk have none. */
const stats = computed(() => {
  const disk = data.value
  if (!disk) return null
  let valid = 0
  let traversable = 0
  let reachable = 0
  let visible = 0
  const { heights } = disk.grid
  for (let k = 0; k < heights.length; k++) {
    if (Number.isNaN(heights[k]!)) continue
    valid++
    traversable += disk.traversable[k]!
    reachable += disk.reachable[k]!
    visible += disk.visible[k]!
  }
  const share = (n: number): string => `${n.toLocaleString()} (${((100 * n) / valid).toFixed(1)}%)`
  return {
    grid: `${disk.grid.width}×${disk.grid.height} (${valid.toLocaleString()} with height)`,
    traversable: share(traversable),
    reachable: share(reachable),
    visible: share(visible),
    height: `${disk.minHeight.toFixed(2)} … ${disk.maxHeight.toFixed(2)} m`,
    computeMs: disk.computeMs === null ? '—' : `${disk.computeMs} ms`,
  }
})

function format(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

onMounted(render)
</script>

<template>
  <UContainer class="py-6 space-y-4">
    <h1 class="text-lg font-semibold">Stop disk viewer</h1>

    <form class="flex flex-wrap items-end gap-3" @submit.prevent="render">
      <UFormField label="Seed">
        <UInput v-model="params.seed" class="w-32" />
      </UFormField>
      <UFormField label="x (m)">
        <UInputNumber v-model="params.x" :step="64" class="w-32" />
      </UFormField>
      <UFormField label="y (m)">
        <UInputNumber v-model="params.y" :step="64" class="w-32" />
      </UFormField>
      <UFormField label="Radius (m)">
        <UInputNumber v-model="params.radius" :min="50" :max="800" :step="50" class="w-32" />
      </UFormField>
      <UFormField label="Amplitude (m)">
        <UInputNumber v-model="params.amplitude" :min="0" :step="1" class="w-32" />
      </UFormField>
      <UFormField label="Gain">
        <UInputNumber
          v-model="params.gain"
          :min="0.05"
          :step="0.05"
          :format-options="{ maximumFractionDigits: 2 }"
          class="w-32"
        />
      </UFormField>
      <UFormField label="Craters / cell">
        <UInputNumber v-model="params.craters" :min="0" :step="1" class="w-32" />
      </UFormField>
      <UButton type="submit" :loading="loading" icon="i-lucide-refresh-cw">Render</UButton>
    </form>

    <div class="flex flex-wrap gap-4">
      <USwitch v-model="overlays.hillshade" label="Hillshade" />
      <USwitch v-model="overlays.traversable" label="Untraversable (red)" />
      <USwitch v-model="overlays.reachable" label="Reachable (cyan, ring = seed)" />
      <USwitch v-model="overlays.fog" label="Fog outside viewshed" />
    </div>

    <UAlert v-if="error" color="error" :title="error" />

    <div class="grid gap-4 lg:grid-cols-[1fr_16rem]">
      <div class="space-y-4">
        <canvas
          ref="canvas"
          class="w-full h-auto bg-black [image-rendering:pixelated]"
          @pointermove="onPointerMove"
          @pointerleave="hover = null"
        />
        <UCard v-if="stats" class="text-sm font-mono">
          <template #header>Stats</template>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3">
            <dt>grid</dt>
            <dd>{{ stats.grid }}</dd>
            <dt>traversable</dt>
            <dd>{{ stats.traversable }}</dd>
            <dt>reachable</dt>
            <dd>{{ stats.reachable }}</dd>
            <dt>visible</dt>
            <dd>{{ stats.visible }}</dd>
            <dt>height</dt>
            <dd>{{ stats.height }}</dd>
            <dt>compute</dt>
            <dd>{{ stats.computeMs }}</dd>
          </dl>
        </UCard>
      </div>

      <div class="text-sm font-mono">
        <UCard>
          <template #header>Hover</template>
          <dl v-if="readout" class="grid grid-cols-[auto_1fr] gap-x-3">
            <dt>x, y</dt>
            <dd>{{ readout.x }}, {{ readout.y }} m</dd>
            <dt>height</dt>
            <dd>{{ format(readout.height, 2) }} m</dd>
            <dt>slope</dt>
            <dd>{{ format(readout.slope, 1) }}°</dd>
            <dt>flags</dt>
            <dd>{{ readout.flags }}</dd>
          </dl>
          <p v-else class="text-muted">Move over the map.</p>
        </UCard>
      </div>
    </div>
  </UContainer>
</template>
