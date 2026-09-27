<script setup lang="ts">
import type {
  ContourTile,
  GridRect,
  GroundView,
  MapBounds,
  MapObject,
  MapView,
  PreviewResult,
  ReliefFog,
  RoverObject,
} from '#shared/utils/client'
import {
  clampView,
  CONTOUR_INTERVAL_M,
  CONTOUR_MAJOR_EVERY,
  contourLines,
  contourTiles,
  easeFocus,
  expandRect,
  fitView,
  FOCUS_EASE_MS,
  FOG_EDGE_CELLS,
  FOG_FILL,
  fogCover,
  HIT_TOLERANCE_PX,
  hitMapObject,
  maskChange,
  panBy,
  reliefPixels,
  ROVER_ID,
  screenToWorld,
  worldToScreen,
  zoomAbout,
} from '#shared/utils/client'
import { RELIEF_STOPS, rgbHex, routeDestination, SEEN_STOPS } from '#shared/utils/client/scene'
import type { MapPoint } from '#shared/utils/mission'
import type { HeightGrid } from '#shared/utils/terrain'
import { surveyMask } from '#shared/utils/terrain'
import FloatingObjectCard from '~/components/inspect/FloatingObjectCard.vue'

const props = withDefaults(
  defineProps<{
    /**
     * The stop disk's stitched grid, whole or still arriving; the relief is drawn as it arrives,
     * each chunk's rectangle as it lands.
     */
    terrain?: GroundView
    /** One byte per grid vertex; unseen ground is hidden under fog, and fades in as it grows. */
    seen?: Uint8Array
    /**
     * One byte per grid vertex, 1 where the rover has the ground in sight now; revealed ground
     * out of it, or all of it while there is none, is drawn as seen before.
     */
    sight?: Uint8Array
    /** The survey: ground beyond `radius` of `center` is not drawn, only a ring at its edge. */
    center: MapPoint
    radius: number
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
    /**
     * What can be inspected: hovering (or a first tap) shows its card, a click (or a second tap)
     * focuses it. With `roverObject` the rover is inspectable too.
     */
    objects?: readonly MapObject[]
    roverObject?: RoverObject
  }>(),
  {
    terrain: undefined,
    seen: undefined,
    sight: undefined,
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
    objects: () => [],
    roverObject: undefined,
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

/** Fixed for the disk, so tints do not shift as ground is revealed or arrives. */
const heightRange = computed(() => {
  if (props.terrain?.heightRange) return props.terrain.heightRange
  let min = Infinity
  let max = -Infinity
  for (const h of props.terrain?.grid.heights ?? []) {
    if (Number.isNaN(h)) continue
    if (h < min) min = h
    if (h > max) max = h
  }
  return min <= max ? { min, max } : undefined
})

const colorMode = useColorMode()
const fogRgb = computed(() => FOG_FILL[colorMode.value === 'dark' ? 'dark' : 'light'])
const fade = useRevealFade(
  () => props.seen,
  () => props.terrain?.grid,
)

/** Contours are built per tile of this many cells, so a reveal rebuilds only the tiles it touches. */
const CONTOUR_TILE = 64
interface ReliefImage {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  data: ImageData
  /** Per vertex, 1 where no fog covers it: where contours may be drawn. */
  clear: Uint8Array
  /** Per tile, the minor and index contours in grid vertex units. */
  contours: Map<number, { minor: Path2D; major: Path2D }>
}
/**
 * The relief at one pixel per vertex, repainted where the ground, the fog or its fade changes.
 * The image lives outside Vue's reactivity; `painted` counts repaints to trigger a redraw.
 */
let relief: ReliefImage | undefined
const painted = ref(0)
/** How many of the terrain's placed rectangles the relief shows. */
let shownPlaced = 0

/**
 * Per grid vertex, 1 within the survey: beyond it the map shows its own background. Kept while
 * the grid and the survey stay, as views of arriving ground come and go.
 */
let surveyKey = ''
const inside = computed<Uint8Array | undefined>((previous) => {
  const terrain = props.terrain
  if (!terrain) return undefined
  const { grid, origin } = terrain
  const { x, y } = props.center
  const key = `${grid.width},${grid.height},${grid.cellSize},${origin.i},${origin.j},${x},${y},${props.radius}`
  if (previous && surveyKey === key) return previous
  surveyKey = key
  return surveyMask(terrain, { center: props.center, radius: props.radius })
})

/** The sight when it fits the grid drawn; one that does not is no sight. */
const shownSight = computed(() => {
  const grid = props.terrain?.grid
  return grid && props.sight?.length === grid.width * grid.height ? props.sight : undefined
})

/** What changed since the last paint; without it everything is repainted. */
interface ReliefUpdate {
  /** Rectangles the fog changed. */
  changed?: readonly GridRect[]
  /** Rectangles whose ground came into sight or left it: colours only. */
  recoloured?: readonly GridRect[]
  /** Rectangles of ground that arrived. */
  arrived?: readonly GridRect[]
  /** The last of the ground arrived. */
  completed?: boolean
}

function paint(update?: ReliefUpdate): void {
  const terrain = props.terrain
  shownPlaced = terrain?.placed?.length ?? 0
  if (!terrain || typeof document === 'undefined' || typeof ImageData === 'undefined') {
    relief = undefined
    painted.value++
    return
  }
  const { grid } = terrain
  const { width, height } = grid
  const frame = fade.value
  // Flags that do not fit the grid leave nothing to hide by: draw no ground rather than all of it.
  if (props.seen && !frame) {
    relief = undefined
    painted.value++
    return
  }
  if (!relief || relief.data.width !== width || relief.data.height !== height) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return
    relief = {
      canvas,
      context,
      data: new ImageData(width, height),
      clear: new Uint8Array(width * height),
      contours: new Map(),
    }
    update = undefined
  }
  const fog = frame && {
    ...frame.fog,
    rgb: fogRgb.value,
    origin: terrain.origin,
    sight: shownSight.value,
  }
  const complete = terrain.complete ?? true
  const tiles = (area: GridRect) => contourTiles(grid, area, { tile: CONTOUR_TILE, complete })
  const whole = { i0: 0, j0: 0, i1: width, j1: height }
  if (!update) {
    relief.contours.clear()
    if (complete) paintArea(relief, grid, fog, whole)
    else {
      // Only what has arrived: fog and relief over the rest would be computed for nothing.
      relief.data.data.fill(0)
      relief.clear.fill(0)
      relief.context.putImageData(relief.data, 0, 0)
      for (const rect of terrain.placed ?? [])
        paintArea(relief, grid, fog, expandRect(rect, 1, grid))
    }
    buildContours(relief, tiles(whole))
    painted.value++
    return
  }
  // The soft edge moves with a reveal: repaint that far around each change.
  for (const rect of update.changed ?? []) {
    const area = expandRect(rect, FOG_EDGE_CELLS + 1, grid)
    paintArea(relief, grid, fog, area)
    buildContours(relief, tiles(area))
  }
  // New ground shades the vertex beside it too; tiles already traced keep their lines.
  const untraced = (area: GridRect) => tiles(area).filter((t) => !relief!.contours.has(t.index))
  for (const rect of update.arrived ?? []) {
    paintArea(relief, grid, fog, expandRect(rect, 1, grid))
    buildContours(relief, untraced(rect))
  }
  if (update.completed) buildContours(relief, untraced(whole))
  for (const rect of update.recoloured ?? []) paintArea(relief, grid, fog, rect)
  painted.value++
}

/** Pixels and the fog-free flags of `area`. */
function paintArea(
  image: ReliefImage,
  grid: HeightGrid,
  fog: ReliefFog | undefined,
  area: GridRect,
): void {
  const { width, height } = grid
  const survey = inside.value
  reliefPixels(grid, {
    heightRange: heightRange.value,
    fog,
    inside: survey,
    rect: area,
    into: image.data.data,
  })
  const cover = fog && fogCover(fog, grid, { rect: area, inside: survey })
  const areaWidth = area.i1 - area.i0
  for (let j = area.j0; j < area.j1; j++) {
    for (let i = area.i0; i < area.i1; i++) {
      const k = j * width + i
      image.clear[k] =
        (!survey || survey[k] === 1) &&
        (!cover || cover[(j - area.j0) * areaWidth + (i - area.i0)] === 0)
          ? 1
          : 0
    }
  }
  image.context.putImageData(
    image.data,
    0,
    0,
    area.i0,
    height - area.j1,
    areaWidth,
    area.j1 - area.j0,
  )
}

function buildContours(image: ReliefImage, tiles: readonly ContourTile[]): void {
  const terrain = props.terrain
  if (!terrain || typeof Path2D === 'undefined') return
  for (const { index, rect } of tiles) {
    const minor = new Path2D()
    const major = new Path2D()
    for (const level of contourLines(terrain.grid, { mask: image.clear, rect })) {
      const path = level.major ? major : minor
      const s = level.segments
      for (let k = 0; k < s.length; k += 4) {
        path.moveTo(s[k]!, s[k + 1]!)
        path.lineTo(s[k + 2]!, s[k + 3]!)
      }
    }
    image.contours.set(index, { minor, major })
  }
}

watch(
  [() => props.terrain, fogRgb, heightRange, fade, shownSight, inside] as const,
  (next, previous) => {
    const [terrain, rgb, range, frame, sight, survey] = next
    const before = previous?.[0]
    const sameGround =
      !!relief &&
      !!terrain &&
      before?.grid === terrain.grid &&
      before.origin === terrain.origin &&
      previous?.[1] === rgb &&
      previous[2] === range &&
      previous[5] === survey
    if (!sameGround) return paint()
    const update: ReliefUpdate = {}
    if (frame !== previous[3]) {
      // A frame without rectangles is a fog to draw afresh.
      if (!frame?.rects) return paint()
      update.changed = frame.rects
    }
    update.arrived = terrain.placed?.slice(shownPlaced) ?? []
    update.completed = (terrain.complete ?? true) && !(before.complete ?? true)
    const sightBefore = previous[4]
    if (sight !== sightBefore) {
      // No sight at all draws as nothing in sight.
      const none = new Uint8Array(terrain.grid.width * terrain.grid.height)
      const rect = maskChange(sightBefore ?? none, sight ?? none, terrain.grid.width)
      if (rect) update.recoloured = [rect]
    }
    paint(update)
  },
  { immediate: true },
)

/** Contour stroke widths in screen pixels, and the zoom (pixels per metre) where 1 m lines show. */
const CONTOUR_STYLE = { minorPx: 0.6, majorPx: 1.2, minorFrom: 1, minorFull: 2.5 }

const legend = computed(() => {
  const range = heightRange.value
  if (!range) return undefined
  const gradient = (ramp: typeof RELIEF_STOPS) =>
    `linear-gradient(to right, ${ramp
      .map((rgb, k) => `${rgbHex(rgb)} ${(100 * k) / (ramp.length - 1)}%`)
      .join(', ')})`
  return {
    gradient: gradient(RELIEF_STOPS),
    seen: gradient(SEEN_STOPS),
    min: range.min.toFixed(0),
    max: range.max.toFixed(0),
  }
})

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
  const image = relief
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
  context.drawImage(
    image.canvas,
    topLeft.x,
    topLeft.y,
    image.canvas.width * side,
    image.canvas.height * side,
  )
  if (image.contours.size === 0) return

  // Contours are in grid vertex units: scale by the cell, flip north up, from vertex (0, 0).
  const corner = worldToScreen(current, {
    x: terrain.origin.i * cellSize,
    y: terrain.origin.j * cellSize,
  })
  context.setTransform(ratio * side, 0, 0, -ratio * side, ratio * corner.x, ratio * corner.y)
  context.strokeStyle = CONTOUR_COLOR
  context.lineCap = 'round'
  const { minorPx, majorPx, minorFrom, minorFull } = CONTOUR_STYLE
  // 1 m lines closer than a pixel or two apart would be a smear: they fade in with the zoom.
  const minorAlpha = Math.min(1, Math.max(0, (current.scale - minorFrom) / (minorFull - minorFrom)))
  if (minorAlpha > 0) {
    context.globalAlpha = 0.3 * minorAlpha
    context.lineWidth = minorPx / side
    for (const tile of image.contours.values()) context.stroke(tile.minor)
  }
  context.globalAlpha = 0.5
  context.lineWidth = majorPx / side
  for (const tile of image.contours.values()) context.stroke(tile.major)
  context.globalAlpha = 1
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

/** Contours are a darker line over any tint. */
const CONTOUR_COLOR = '#2a1408'

watch([view, painted], scheduleDraw)

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

/** The route's destination, flagged until a stop stands there, as the 3D scene flags it. */
const destinationMarker = computed(() => {
  const end = view.value && routeDestination(props.plan, props.trail)
  return end ? toScreen(end) : undefined
})

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
  endEase()
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
    if (event.pointerType === 'mouse') {
      emit('hover', screenToWorld(current, at))
      const hit = hitAt(at)
      hovered.value = hit ? { id: hit.id, client: { x: event.clientX, y: event.clientY } } : null
    }
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
    release()
    return
  }
  if (tap && !tap.moved && Math.hypot(at.x - tap.x, at.y - tap.y) <= TAP_SLOP_PX) return
  if (tap) tap.moved = true
  settle(panBy(current, { dx: at.x - before.x, dy: at.y - before.y }))
  release()
}

function onPointerUp(event: PointerEvent): void {
  if (!pressed.delete(event.pointerId)) return
  if (pressed.size < 2) pinch = undefined
  if (pressed.size === 0 && tap && !tap.moved && view.value) onTap(event)
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
      // A followed rover stays in the middle.
      at: following ? { x: current.width / 2, y: current.height / 2 } : local(event),
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

function fitDisk(): void {
  release()
  if (fitted.value) view.value = fitted.value
}

/* Inspecting: cards on hover or a first tap, focus on a click or a second tap. */

const mapFocus = useMapFocus()
/** The object whose card shows, and the pointer it follows, in client pixels. */
const hovered = shallowRef<{ id: string; client: { x: number; y: number } } | null>(null)
const inspectable = computed((): readonly MapObject[] =>
  props.roverObject ? [...props.objects, props.roverObject] : props.objects,
)
const hoveredObject = computed(() => {
  const id = hovered.value?.id
  return id ? inspectable.value.find((o) => o.id === id) : undefined
})

function hitAt(at: { x: number; y: number }): MapObject | undefined {
  const current = view.value
  if (!current || inspectable.value.length === 0) return undefined
  return hitMapObject(inspectable.value, screenToWorld(current, at), {
    toleranceM: HIT_TOLERANCE_PX / current.scale,
  })
}

function onTap(event: PointerEvent): void {
  const hit = hitAt(local(event))
  if (!hit) {
    hovered.value = null
    emit('pick', screenToWorld(view.value!, local(event)))
    return
  }
  // A finger has no hover: its first tap shows the card, the second focuses.
  if (event.pointerType !== 'mouse' && hovered.value?.id !== hit.id) {
    hovered.value = { id: hit.id, client: { x: event.clientX, y: event.clientY } }
    return
  }
  if (event.pointerType !== 'mouse') hovered.value = null
  mapFocus.focusOn(hit.id)
}

function onLeave(event: PointerEvent): void {
  emit('hover', null)
  // A lifted finger leaves too: a tapped card stays until the next tap.
  if (event.pointerType === 'mouse') hovered.value = null
}

/** Where the focused object is: the rover as drawn, the others as listed. */
function focusTarget(): MapPoint | undefined {
  const id = mapFocus.focused.value
  if (id === ROVER_ID && props.rover) return props.rover
  const object = props.objects.find((o) => o.id === id)
  return object && { x: object.x, y: object.y }
}

/** Following the rover: set by the recentre control, ended by panning. */
let following = false
let ease: { from: MapPoint; started: number } | undefined
let easeFrame = 0

function endEase(): void {
  ease = undefined
  if (easeFrame) cancelAnimationFrame(easeFrame)
  easeFrame = 0
}

/** The visitor took the view: no more following or easing. */
function release(): void {
  following = false
  endEase()
}

function stepEase(): void {
  easeFrame = 0
  const current = view.value
  const to = focusTarget()
  if (!ease || !current || !to) return endEase()
  const elapsed = performance.now() - ease.started
  settle({ ...current, center: easeFocus(ease.from, to, elapsed) })
  if (elapsed >= FOCUS_EASE_MS) ease = undefined
  else easeFrame = requestAnimationFrame(stepEase)
}

watch(mapFocus.seq, () => {
  endEase()
  const current = view.value
  following = mapFocus.focused.value === ROVER_ID
  if (!current || !focusTarget()) return
  ease = { from: { ...current.center }, started: performance.now() }
  easeFrame = requestAnimationFrame(stepEase)
})

watch(
  () => props.rover,
  (rover) => {
    const current = view.value
    if (following && !ease && rover && current) {
      settle({ ...current, center: { x: rover.x, y: rover.y } })
    }
  },
)

onBeforeUnmount(endEase)

const focusRing = computed(() => {
  const target = view.value && mapFocus.focused.value !== null ? focusTarget() : undefined
  return target && toScreen(target)
})
</script>

<template>
  <div
    ref="container"
    data-test="map"
    class="relative h-full w-full touch-none select-none overflow-hidden bg-(--ui-bg-muted)"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onLeave"
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
        data-test="survey-ring"
        :cx="toScreen(center).x"
        :cy="toScreen(center).y"
        :r="scaled(radius)"
        class="fill-none stroke-(--ui-text-muted)"
        stroke-width="1"
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
      <g
        v-if="destinationMarker"
        data-test="destination-marker"
        :transform="`translate(${destinationMarker.x} ${destinationMarker.y})`"
      >
        <path d="M 0 0 V -12" class="stroke-(--ui-text-highlighted)" stroke-width="1.5" />
        <path
          d="M 0.75 -12 h 9 v 6 h -9 Z"
          class="fill-(--ui-primary) stroke-(--ui-bg)"
          stroke-width="1"
        />
      </g>
      <g
        v-for="(death, k) in deaths"
        :key="`death-${k}`"
        data-test="death-marker"
        :data-at="`${Math.round(toScreen(death).x)},${Math.round(toScreen(death).y)}`"
      >
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
      <circle
        v-if="focusRing"
        data-test="focus-ring"
        :cx="focusRing.x"
        :cy="focusRing.y"
        r="13"
        class="fill-none stroke-(--ui-warning)"
        stroke-width="2"
      />
      <g
        v-if="roverMarker"
        data-test="rover-marker"
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
        @click="fitDisk"
      />
      <UButton
        v-if="rover"
        data-test="recenter"
        icon="i-lucide-crosshair"
        size="xs"
        color="neutral"
        variant="solid"
        aria-label="Recentre on the rover and follow it"
        @pointerdown.stop
        @click="mapFocus.recentre()"
      />
    </div>
    <div
      v-if="legend && terrain"
      data-test="relief-legend"
      class="pointer-events-none absolute bottom-2 left-2 rounded bg-(--ui-bg)/75 px-1.5 py-1 text-[10px] leading-tight text-muted tabular-nums"
    >
      <div class="flex items-end gap-2">
        <div class="w-20">
          <div class="h-1.5 rounded-sm" :style="{ background: legend.gradient }" />
          <div class="flex justify-between gap-2">
            <span>{{ legend.min }} m</span><span>{{ legend.max }} m</span>
          </div>
        </div>
        <div v-if="seen" data-test="legend-seen">
          <div class="h-1.5 w-6 rounded-sm" :style="{ background: legend.seen }" />
          <span>seen before</span>
        </div>
      </div>
      <div>
        contours {{ CONTOUR_INTERVAL_M }} m, bold {{ CONTOUR_INTERVAL_M * CONTOUR_MAJOR_EVERY }} m
      </div>
    </div>
    <FloatingObjectCard
      v-if="hovered && hoveredObject"
      :object="hoveredObject"
      :client="hovered.client"
    />
    <slot />
  </div>
</template>
