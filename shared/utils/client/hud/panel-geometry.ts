/** A panel's box in the HUD area, pixels from its top-left corner. */
export interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelSize {
  width: number
  height: number
}

/** Pointer travel, pixels. */
export interface PanelDelta {
  x: number
  y: number
}

/**
 * Which edges a resize moves on each axis: `1` the right or bottom edge, `-1` the left or top
 * edge, `0` neither. A corner handle moves one edge on each axis.
 */
export interface ResizeHandle {
  x: -1 | 0 | 1
  y: -1 | 0 | 1
}

/** The smallest a panel can be resized to: its title bar and a readable strip of content. */
export const PANEL_MIN_SIZE: PanelSize = { width: 200, height: 120 }
/** An edge dragged within this many pixels of a side of the area sticks to it. */
export const PANEL_SNAP_PX = 12
/** The gap a snapped panel keeps from the side of the area. */
export const PANEL_MARGIN_PX = 8

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * `rect` made to fit `bounds`: at least the minimum size unless the bounds are smaller, at most
 * the bounds, and moved back inside them. Nothing of a clamped panel is ever off screen.
 */
export function clampRect(
  rect: PanelRect,
  bounds: PanelSize,
  options: { minSize?: PanelSize } = {},
): PanelRect {
  const min = options.minSize ?? PANEL_MIN_SIZE
  const width = Math.min(bounds.width, Math.max(min.width, rect.width))
  const height = Math.min(bounds.height, Math.max(min.height, rect.height))
  return {
    x: clamp(rect.x, 0, bounds.width - width),
    y: clamp(rect.y, 0, bounds.height - height),
    width,
    height,
  }
}

/** `rect` with each edge that lies within `distance` of the margin line of a side moved onto it. */
export function snapRect(
  rect: PanelRect,
  bounds: PanelSize,
  options: { distance?: number; margin?: number } = {},
): PanelRect {
  const distance = options.distance ?? PANEL_SNAP_PX
  const margin = options.margin ?? PANEL_MARGIN_PX
  const snap = (start: number, size: number, extent: number) => {
    if (Math.abs(start - margin) < distance) return margin
    const end = extent - margin - size
    if (Math.abs(start - end) < distance) return end
    return start
  }
  return {
    ...rect,
    x: snap(rect.x, rect.width, bounds.width),
    y: snap(rect.y, rect.height, bounds.height),
  }
}

/** `rect` moved by the pointer's travel, snapped to the sides it nears and kept inside `bounds`. */
export function dragRect(
  rect: PanelRect,
  delta: PanelDelta,
  bounds: PanelSize,
  options: { distance?: number; margin?: number; minSize?: PanelSize } = {},
): PanelRect {
  const moved = { ...rect, x: rect.x + delta.x, y: rect.y + delta.y }
  return clampRect(snapRect(moved, bounds, options), bounds, options)
}

/**
 * `rect` resized by the pointer's travel on the edges `handle` names; the opposite edges stay
 * put. The size stays between the minimum and what the bounds leave on that side.
 */
export function resizeRect(
  rect: PanelRect,
  delta: PanelDelta,
  bounds: PanelSize,
  options: { handle: ResizeHandle; minSize?: PanelSize },
): PanelRect {
  const min = options.minSize ?? PANEL_MIN_SIZE
  const axis = (
    start: number,
    size: number,
    move: number,
    side: -1 | 0 | 1,
    extent: number,
    minSize: number,
  ): [number, number] => {
    const floor = Math.min(minSize, extent)
    if (side === 1) return [start, clamp(size + move, floor, extent - start)]
    if (side === -1) {
      const end = start + size
      const next = clamp(start + move, 0, end - floor)
      return [next, end - next]
    }
    return [start, size]
  }
  const [x, width] = axis(rect.x, rect.width, delta.x, options.handle.x, bounds.width, min.width)
  const [y, height] = axis(
    rect.y,
    rect.height,
    delta.y,
    options.handle.y,
    bounds.height,
    min.height,
  )
  return { x, y, width, height }
}
