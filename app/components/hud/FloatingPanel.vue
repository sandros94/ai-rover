<script setup lang="ts">
import type { PanelRect, PanelSize, ResizeHandle } from '#shared/utils/client/hud'
import { clampRect, dragRect, resizeRect } from '#shared/utils/client/hud'

/**
 * A window over the scene: dragged by its title bar, resized from its edges and corners, with
 * mouse, pen or touch; minimised to the title bar or closed. It is drawn fitted to `bounds`, and
 * reports its rect only when a gesture ends, so dragging redraws the panel alone.
 */
const props = withDefaults(
  defineProps<{
    panelId: string
    title: string
    icon?: string
    /** As stored; drawn fitted to `bounds`. */
    rect: PanelRect
    /** The HUD area the panel lives in. */
    bounds: PanelSize
    minimised?: boolean
    /** Stacking order within the HUD. */
    z?: number
  }>(),
  { icon: undefined, minimised: false, z: 0 },
)

const emit = defineEmits<{
  move: [rect: PanelRect]
  minimise: [minimised: boolean]
  close: []
  /** A press anywhere on the panel: raise it. */
  focus: []
}>()

/** Edges and corners that resize, as the geometry names them. */
const HANDLES: { name: string; handle: ResizeHandle; class: string }[] = [
  { name: 'e', handle: { x: 1, y: 0 }, class: 'inset-y-2 -right-1 w-2 cursor-ew-resize' },
  { name: 'w', handle: { x: -1, y: 0 }, class: 'inset-y-2 -left-1 w-2 cursor-ew-resize' },
  { name: 's', handle: { x: 0, y: 1 }, class: 'inset-x-2 -bottom-1 h-2 cursor-ns-resize' },
  { name: 'se', handle: { x: 1, y: 1 }, class: '-right-1 -bottom-1 size-4 cursor-nwse-resize' },
  { name: 'sw', handle: { x: -1, y: 1 }, class: '-left-1 -bottom-1 size-4 cursor-nesw-resize' },
]

const fitted = computed(() => clampRect(props.rect, props.bounds))
/** The rect while a gesture is under way. */
const moving = shallowRef<PanelRect>()
const shown = computed(() => moving.value ?? fitted.value)

let gesture:
  | { pointerId: number; x: number; y: number; from: PanelRect; handle?: ResizeHandle }
  | undefined

function start(event: PointerEvent, handle?: ResizeHandle): void {
  if (event.button !== 0 || gesture) return
  event.preventDefault()
  const target = event.currentTarget as Element
  target.setPointerCapture?.(event.pointerId)
  gesture = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    from: fitted.value,
    handle,
  }
}

function move(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return
  const delta = { x: event.clientX - gesture.x, y: event.clientY - gesture.y }
  moving.value = gesture.handle
    ? resizeRect(gesture.from, delta, props.bounds, { handle: gesture.handle })
    : dragRect(gesture.from, delta, props.bounds)
}

function end(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return
  gesture = undefined
  if (moving.value) emit('move', moving.value)
  moving.value = undefined
}
</script>

<template>
  <section
    data-test="panel"
    :data-panel="panelId"
    :aria-label="title"
    class="pointer-events-auto absolute top-0 left-0 flex flex-col overflow-hidden rounded-lg bg-(--ui-bg)/90 shadow-lg ring ring-(--ui-border) backdrop-blur-sm"
    :style="{
      transform: `translate(${shown.x}px, ${shown.y}px)`,
      width: `${shown.width}px`,
      height: minimised ? undefined : `${shown.height}px`,
      zIndex: z,
    }"
    @pointerdown="emit('focus')"
  >
    <header
      class="flex h-8 shrink-0 cursor-grab touch-none items-center gap-1.5 border-b border-(--ui-border) pr-1 pl-2 select-none active:cursor-grabbing"
      @pointerdown="start"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
      @dblclick="emit('minimise', !minimised)"
    >
      <UIcon v-if="icon" :name="icon" class="size-3.5 shrink-0 text-muted" />
      <h2 class="min-w-0 flex-1 truncate text-xs font-medium">{{ title }}</h2>
      <UButton
        data-test="panel-minimise"
        :icon="minimised ? 'i-lucide-chevron-down' : 'i-lucide-minus'"
        :aria-label="minimised ? `Expand ${title}` : `Minimise ${title}`"
        size="xs"
        color="neutral"
        variant="ghost"
        @pointerdown.stop
        @click="emit('minimise', !minimised)"
      />
      <UButton
        data-test="panel-close"
        icon="i-lucide-x"
        :aria-label="`Close ${title}`"
        size="xs"
        color="neutral"
        variant="ghost"
        @pointerdown.stop
        @click="emit('close')"
      />
    </header>
    <div
      v-show="!minimised"
      class="min-h-0 flex-1 overflow-auto *:rounded-none *:shadow-none *:ring-0"
    >
      <slot />
    </div>
    <template v-if="!minimised">
      <div
        v-for="h in HANDLES"
        :key="h.name"
        data-test="panel-resize"
        :data-handle="h.name"
        :class="['absolute touch-none', h.class]"
        @pointerdown.stop="start($event, h.handle)"
        @pointermove="move"
        @pointerup="end"
        @pointercancel="end"
      />
    </template>
  </section>
</template>
