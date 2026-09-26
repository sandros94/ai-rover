<script setup lang="ts">
import type { MapBounds, MapView, PreviewResult } from '#shared/utils/client'
import {
  clampView,
  fitView,
  panBy,
  reliefPixels,
  screenToWorld,
  worldToScreen,
  zoomAbout,
} from '#shared/utils/client'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'

const props = withDefaults(
  defineProps<{
    /** The stop disk's stitched grid; the relief is drawn once it is present. */
    terrain?: { grid: HeightGrid; origin: GridCell }
    /** One byte per grid vertex; unseen ground is drawn dimmed and grey. */
    seen?: Uint8Array
    center: MapPoint
    radius: number
    /** Where picks are measured from, with the allowed distance band around it. */
    anchor?: MapPoint
    ring?: { minM: number; maxM: number }
    rover?: { x: number; y: number; headingRad: number }
    trail?: MapPoint[]
    /** The route being driven. */
    plan?: MapPoint[]
    /** Where the rover has driven so far this segment. */
    driven?: MapPoint[]
    deaths?: MapPoint[]
    deathRadiusM?: number
    submissions?: { id: string; goal: MapPoint; mine?: boolean }[]
    highlightId?: string | null
    preview?: PreviewResult
    /** The tapped point waiting for confirmation. */
    picked?: MapPoint | null
  }>(),
  {
    terrain: undefined,
    seen: undefined,
    anchor: undefined,
    ring: undefined,
    rover: undefined,
    trail: () => [],
    plan: () => [],
    driven: () => [],
    deaths: () => [],
    deathRadiusM: 30,
    submissions: () => [],
    highlightId: null,
    preview: undefined,
    picked: null,
  },
)

const emit = defineEmits<{
  pick: [point: MapPoint]
  hover: [point: MapPoint | null]
}>()

/** Finger travel, pixels, beyond which a press is a drag and not a tap. */
const TAP_SLOP_PX = 6
/** Closest zoom, pixels per metre. */
const MAX_SCALE = 16
/** Slope thresholds, degrees, of the route colours: gentle, moderate, near the limit. */
const SLOPE_STEPS = [6, 12] as const

const container = useTemplateRef<HTMLDivElement>('container')
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const size = ref({ width: 0, height: 0 })
const view = shallowRef<MapView>()

const bounds = computed<MapBounds>(() => ({
  minX: props.center.x - props.radius,
  minY: props.center.y - props.radius,
  maxX: props.center.x + props.radius,
  maxY: props.center.y + props.radius,
}))
const fitted = computed(() =>
  size.value.width > 0 && size.value.height > 0
    ? fitView(bounds.value, { ...size.value, padding: 8 })
    : undefined,
)
const limits = computed(() => ({
  minScale: (fitted.value?.scale ?? 1) * 0.5,
  maxScale: Math.max(MAX_SCALE, fitted.value?.scale ?? 1),
}))

watch(fitted, (next, previous) => {
  if (!next) return
  const current = view.value
  const untouched =
    !current ||
    !previous ||
    (current.scale === previous.scale &&
      current.center.x === previous.center.x &&
      current.center.y === previous.center.y)
  // A view the user has panned or zoomed survives a resize; an untouched one refits.
  view.value = untouched ? next : { ...current, width: next.width, height: next.height }
})

function measure(): void {
  const rect = container.value?.getBoundingClientRect()
  if (rect) size.value = { width: rect.width, height: rect.height }
}

/** The relief at one pixel per vertex, redrawn only when the ground or the fog changes. */
const relief = shallowRef<HTMLCanvasElement>()
watch(
  () => [props.terrain, props.seen] as const,
  ([terrain, seen]) => {
    relief.value = undefined
    if (!terrain || typeof document === 'undefined') return
    const { width, height } = terrain.grid
    const image = document.createElement('canvas')
    image.width = width
    image.height = height
    const context = image.getContext('2d')
    if (!context || typeof ImageData === 'undefined') return
    const pixels = reliefPixels(terrain.grid, {
      seen: seen?.length === width * height ? seen : undefined,
    })
    context.putImageData(new ImageData(pixels, width, height), 0, 0)
    relief.value = image
  },
  { immediate: true },
)

let frame = 0
function scheduleDraw(): void {
  if (frame || typeof requestAnimationFrame === 'undefined') return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function draw(): void {
  const el = canvas.value
  const current = view.value
  if (!el || !current) return
  const ratio = window.devicePixelRatio || 1
  el.width = Math.round(current.width * ratio)
  el.height = Math.round(current.height * ratio)
  const context = el.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, current.width, current.height)
  const image = relief.value
  const terrain = props.terrain
  if (!image || !terrain) return
  const { cellSize, height } = terrain.grid
  // Pixel (i, row) is centred on vertex (i, height − 1 − row); its square spans half a cell.
  const topLeft = worldToScreen(current, {
    x: (terrain.origin.i - 0.5) * cellSize,
    y: (terrain.origin.j + height - 0.5) * cellSize,
  })
  const side = cellSize * current.scale
  context.imageSmoothingEnabled = side < 3
  context.drawImage(image, topLeft.x, topLeft.y, image.width * side, image.height * side)
}

watch([view, relief], scheduleDraw)

let observer: ResizeObserver | undefined
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && container.value) {
    observer = new ResizeObserver(measure)
    observer.observe(container.value)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})

/* Vectors, in screen pixels so strokes stay crisp at every zoom. */

const toScreen = (p: MapPoint) => (view.value ? worldToScreen(view.value, p) : { x: 0, y: 0 })
const scaled = (metres: number) => metres * (view.value?.scale ?? 0)
const points = (line: readonly MapPoint[]) =>
  line
    .map(toScreen)
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')

const ringPath = computed(() => {
  if (!view.value || !props.anchor || !props.ring) return ''
  const { x, y } = toScreen(props.anchor)
  const circle = (r: number) =>
    `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`
  return `${circle(scaled(props.ring.maxM))} ${circle(scaled(props.ring.minM))}`
})

const slopeClass = (degrees: number | null) =>
  degrees === null
    ? 'stroke-(--ui-text-muted)'
    : degrees < SLOPE_STEPS[0]
      ? 'stroke-(--ui-success)'
      : degrees < SLOPE_STEPS[1]
        ? 'stroke-(--ui-warning)'
        : 'stroke-(--ui-error)'

const previewSegments = computed(() => {
  const preview = props.preview
  if (!view.value || !preview?.ok) return []
  return preview.segmentSlopes.map((slope, k) => ({
    from: toScreen(preview.polyline[k]!),
    to: toScreen(preview.polyline[k + 1]!),
    slope,
    className: slopeClass(slope),
  }))
})
const previewGoal = computed(() =>
  view.value && props.preview?.goal ? toScreen(props.preview.goal) : undefined,
)

const roverMarker = computed(() => {
  if (!view.value || !props.rover) return undefined
  const { x, y } = toScreen(props.rover)
  // Screen y points down, so a counter-clockwise world heading turns the other way on screen.
  return { x, y, degrees: (-props.rover.headingRad * 180) / Math.PI }
})

/* Pointer input: one finger or the mouse pans and taps, two fingers pinch. */

const pressed = new Map<number, { x: number; y: number }>()
let tap: { x: number; y: number; moved: boolean } | undefined
let pinch: { distance: number; mid: { x: number; y: number } } | undefined

function local(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = container.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function settle(next: MapView): void {
  view.value = clampView(next, bounds.value)
}

function pinchState(): { distance: number; mid: { x: number; y: number } } {
  const [a, b] = [...pressed.values()] as [{ x: number; y: number }, { x: number; y: number }]
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const at = local(event)
  pressed.set(event.pointerId, at)
  ;(event.target as Element | null)?.setPointerCapture?.(event.pointerId)
  if (pressed.size === 1) tap = { ...at, moved: false }
  else {
    tap = undefined
    pinch = pinchState()
  }
}

function onPointerMove(event: PointerEvent): void {
  const at = local(event)
  const current = view.value
  if (!current) return
  const before = pressed.get(event.pointerId)
  if (!before) {
    if (event.pointerType === 'mouse') emit('hover', screenToWorld(current, at))
    return
  }
  pressed.set(event.pointerId, at)
  if (pressed.size >= 2 && pinch) {
    const next = pinchState()
    const zoomed = zoomAbout(current, {
      at: next.mid,
      factor: next.distance / Math.max(pinch.distance, 1),
      ...limits.value,
    })
    settle(panBy(zoomed, { dx: next.mid.x - pinch.mid.x, dy: next.mid.y - pinch.mid.y }))
    pinch = next
    return
  }
  if (tap && !tap.moved && Math.hypot(at.x - tap.x, at.y - tap.y) <= TAP_SLOP_PX) return
  if (tap) tap.moved = true
  settle(panBy(current, { dx: at.x - before.x, dy: at.y - before.y }))
}

function onPointerUp(event: PointerEvent): void {
  if (!pressed.delete(event.pointerId)) return
  if (pressed.size < 2) pinch = undefined
  if (pressed.size === 0 && tap && !tap.moved && view.value) {
    emit('pick', screenToWorld(view.value, local(event)))
  }
  if (pressed.size === 0) tap = undefined
}

function onPointerCancel(event: PointerEvent): void {
  pressed.delete(event.pointerId)
  tap = undefined
  pinch = undefined
}

function onWheel(event: WheelEvent): void {
  const current = view.value
  if (!current) return
  settle(
    zoomAbout(current, {
      at: local(event),
      factor: Math.exp(-event.deltaY * 0.0015),
      ...limits.value,
    }),
  )
}

function zoomBy(factor: number): void {
  const current = view.value
  if (!current) return
  settle(
    zoomAbout(current, {
      at: { x: current.width / 2, y: current.height / 2 },
      factor,
      ...limits.value,
    }),
  )
}

function recenter(): void {
  if (fitted.value) view.value = fitted.value
}
</script>

<template>
  <div
    ref="container"
    data-test="map"
    class="relative aspect-square w-full touch-none select-none overflow-hidden rounded-lg bg-(--ui-bg-muted)"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="emit('hover', null)"
    @wheel.prevent="onWheel"
  >
    <canvas ref="canvas" class="absolute inset-0 h-full w-full" />
    <svg
      v-if="view"
      class="pointer-events-none absolute inset-0 h-full w-full"
      :viewBox="`0 0 ${view.width} ${view.height}`"
      aria-hidden="true"
    >
      <circle
        :cx="toScreen(center).x"
        :cy="toScreen(center).y"
        :r="scaled(radius)"
        class="fill-none stroke-(--ui-border-accented)"
        stroke-dasharray="4 4"
      />
      <path
        v-if="ringPath"
        :d="ringPath"
        fill-rule="evenodd"
        class="fill-(--ui-primary)/10 stroke-(--ui-primary)"
        stroke-width="1.5"
      />
      <polyline
        v-if="trail.length > 1"
        :points="points(trail)"
        class="fill-none stroke-(--ui-text-toned)"
        stroke-width="2"
        stroke-dasharray="2 4"
      />
      <circle
        v-for="stop in trail"
        :key="`${stop.x},${stop.y}`"
        :cx="toScreen(stop).x"
        :cy="toScreen(stop).y"
        r="3"
        class="fill-(--ui-text-toned)"
      />
      <polyline
        v-if="plan.length > 1"
        :points="points(plan)"
        class="fill-none stroke-(--ui-info)"
        stroke-width="3"
      />
      <polyline
        v-if="driven.length > 1"
        data-test="driven"
        :points="points(driven)"
        class="fill-none stroke-(--ui-primary)"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      <g v-for="(death, k) in deaths" :key="`death-${k}`">
        <circle
          :cx="toScreen(death).x"
          :cy="toScreen(death).y"
          :r="scaled(deathRadiusM)"
          class="fill-(--ui-error)/15 stroke-(--ui-error)"
          stroke-width="1.5"
        />
        <path
          :d="`M ${toScreen(death).x - 5} ${toScreen(death).y - 5} l 10 10 m 0 -10 l -10 10`"
          class="stroke-(--ui-error)"
          stroke-width="2"
        />
      </g>
      <g v-for="submission in submissions" :key="submission.id">
        <circle
          :cx="toScreen(submission.goal).x"
          :cy="toScreen(submission.goal).y"
          :r="submission.id === highlightId ? 7 : 5"
          :class="[
            submission.mine ? 'fill-(--ui-primary)' : 'fill-(--ui-bg)',
            submission.id === highlightId
              ? 'stroke-(--ui-warning)'
              : 'stroke-(--ui-text-highlighted)',
          ]"
          stroke-width="2"
        />
      </g>
      <line
        v-for="(segment, k) in previewSegments"
        :key="`preview-${k}`"
        :x1="segment.from.x"
        :y1="segment.from.y"
        :x2="segment.to.x"
        :y2="segment.to.y"
        :class="segment.className"
        stroke-width="4"
        stroke-linecap="round"
        :stroke-dasharray="segment.slope === null ? '6 5' : undefined"
      />
      <circle
        v-if="previewGoal"
        :cx="previewGoal.x"
        :cy="previewGoal.y"
        r="6"
        :class="
          preview?.ok
            ? 'fill-(--ui-success) stroke-(--ui-bg)'
            : 'fill-(--ui-error) stroke-(--ui-bg)'
        "
        stroke-width="2"
      />
      <g v-if="picked" :transform="`translate(${toScreen(picked).x} ${toScreen(picked).y})`">
        <circle r="10" class="fill-none stroke-(--ui-text-highlighted)" stroke-width="2" />
        <path
          d="M -14 0 h 8 M 6 0 h 8 M 0 -14 v 8 M 0 6 v 8"
          class="stroke-(--ui-text-highlighted)"
          stroke-width="2"
        />
      </g>
      <g
        v-if="roverMarker"
        :transform="`translate(${roverMarker.x} ${roverMarker.y}) rotate(${roverMarker.degrees})`"
      >
        <path
          d="M 11 0 L -7 7 L -3 0 L -7 -7 Z"
          class="fill-(--ui-primary) stroke-(--ui-bg)"
          stroke-width="1.5"
        />
      </g>
    </svg>
    <div class="absolute right-2 top-2 flex flex-col gap-1">
      <UButton
        icon="i-lucide-plus"
        size="xs"
        color="neutral"
        variant="solid"
        aria-label="Zoom in"
        @pointerdown.stop
        @click="zoomBy(1.5)"
      />
      <UButton
        icon="i-lucide-minus"
        size="xs"
        color="neutral"
        variant="solid"
        aria-label="Zoom out"
        @pointerdown.stop
        @click="zoomBy(1 / 1.5)"
      />
      <UButton
        icon="i-lucide-locate"
        size="xs"
        color="neutral"
        variant="solid"
        aria-label="Fit the disk"
        @pointerdown.stop
        @click="recenter"
      />
    </div>
    <slot />
  </div>
</template>
