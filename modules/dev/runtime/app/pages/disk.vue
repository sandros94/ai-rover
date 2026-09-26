<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { contourLines, FOG_FILL, reliefPixels } from '#shared/utils/client'
import { DEFAULT_CRATERS, DEFAULT_RELIEF, slopeAt } from '#shared/utils/terrain'
import type { DiskWire } from '../../shared/disk-wire'
import { decodeDiskWire } from '../../shared/disk-wire'

interface DiskData extends DiskWire {
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
const overlays = reactive({
  hillshade: true,
  contours: true,
  traversable: true,
  reachable: false,
  trueRelief: false,
})

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
  return { ...disk, minHeight, maxHeight, computeMs }
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
  pixels.set(
    reliefPixels(disk.grid, {
      hillshade: overlays.hillshade,
      // A development view may look through the fog; the app never does.
      fog: overlays.trueRelief
        ? undefined
        : { seen: disk.visible, rgb: FOG_FILL.dark, origin: disk.origin },
      heightRange: { min: disk.minHeight, max: disk.maxHeight },
    }),
  )
  for (let j = 0; j < height; j++) {
    // Grid rows run south to north; canvas rows run top to bottom.
    const row = (height - 1 - j) * width
    for (let i = 0; i < width; i++) {
      const k = j * width + i
      const p = (row + i) * 4
      if (Number.isNaN(heights[k]!)) continue
      if (overlays.traversable && !disk.traversable[k]) {
        pixels[p] = pixels[p]! * 0.45 + 220 * 0.55
        pixels[p + 1] = pixels[p + 1]! * 0.45
        pixels[p + 2] = pixels[p + 2]! * 0.45
      }
      if (overlays.reachable && disk.reachable[k]) {
        pixels[p] = pixels[p]! * 0.6
        pixels[p + 1] = pixels[p + 1]! * 0.6 + 200 * 0.4
        pixels[p + 2] = pixels[p + 2]! * 0.6 + 220 * 0.4
      }
    }
  }
  context.putImageData(image, 0, 0)

  if (overlays.contours) {
    // Grid vertex (i, j) is the centre of pixel (i, height − 1 − j).
    context.setTransform(1, 0, 0, -1, 0.5, height - 0.5)
    const mask = overlays.trueRelief ? undefined : disk.visible
    for (const level of contourLines(disk.grid, { mask })) {
      context.strokeStyle = level.major ? 'rgba(42, 20, 8, 0.55)' : 'rgba(42, 20, 8, 0.25)'
      context.lineWidth = level.major ? 1 : 0.5
      context.beginPath()
      const s = level.segments
      for (let k = 0; k < s.length; k += 4) {
        context.moveTo(s[k]!, s[k + 1]!)
        context.lineTo(s[k + 2]!, s[k + 3]!)
      }
      context.stroke()
    }
    context.setTransform(1, 0, 0, 1, 0, 0)
  }

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
      <USwitch v-model="overlays.contours" label="Contours (1 m, bold 5 m)" />
      <USwitch v-model="overlays.traversable" label="Untraversable (red)" />
      <USwitch v-model="overlays.reachable" label="Reachable (cyan, ring = seed)" />
      <USwitch v-model="overlays.trueRelief" label="True relief (look through the fog)" />
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
