import { ClientError } from './errors'

/**
 * A north-up view of the world on a screen: `center` (world metres) sits in the middle of a
 * `width` × `height` pixel viewport, `scale` pixels per metre. Screen y grows downwards, world y
 * northwards.
 */
export interface MapView {
  center: { x: number; y: number }
  scale: number
  width: number
  height: number
}

/** A world rectangle, metres. */
export interface MapBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function worldToScreen(
  view: MapView,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: view.width / 2 + (point.x - view.center.x) * view.scale,
    y: view.height / 2 - (point.y - view.center.y) * view.scale,
  }
}

export function screenToWorld(
  view: MapView,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: view.center.x + (point.x - view.width / 2) / view.scale,
    y: view.center.y - (point.y - view.height / 2) / view.scale,
  }
}

/** The view showing all of `bounds` centred, `padding` pixels clear on the tighter axis. */
export function fitView(
  bounds: MapBounds,
  options: { width: number; height: number; padding?: number },
): MapView {
  const { width, height, padding = 0 } = options
  if (!(width > 0) || !(height > 0)) {
    throw new ClientError(
      'INVALID_INPUT',
      `fitView: viewport is ${width}×${height} px; pass a positive width and height.`,
    )
  }
  const spanX = Math.max(bounds.maxX - bounds.minX, Number.EPSILON)
  const spanY = Math.max(bounds.maxY - bounds.minY, Number.EPSILON)
  const scale = Math.max(
    Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY),
    Number.EPSILON,
  )
  return {
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    scale,
    width,
    height,
  }
}

/**
 * Zooms by `factor`, clamped to [minScale, maxScale], keeping the world point under the screen
 * point `at` where it is.
 */
export function zoomAbout(
  view: MapView,
  options: { at: { x: number; y: number }; factor: number; minScale: number; maxScale: number },
): MapView {
  const { at, factor, minScale, maxScale } = options
  if (!(factor > 0) || !Number.isFinite(factor)) {
    throw new ClientError(
      'INVALID_INPUT',
      `zoomAbout: factor is ${factor}; pass a positive number.`,
    )
  }
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor))
  const under = screenToWorld(view, at)
  return {
    ...view,
    scale,
    center: {
      x: under.x - (at.x - view.width / 2) / scale,
      y: under.y + (at.y - view.height / 2) / scale,
    },
  }
}

/** Moves the content by `dx`, `dy` screen pixels, as a drag does. */
export function panBy(view: MapView, options: { dx: number; dy: number }): MapView {
  return {
    ...view,
    center: {
      x: view.center.x - options.dx / view.scale,
      y: view.center.y + options.dy / view.scale,
    },
  }
}

/** The view with its centre kept inside `bounds`, so the content can never be lost off-screen. */
export function clampView(view: MapView, bounds: MapBounds): MapView {
  const x = Math.min(bounds.maxX, Math.max(bounds.minX, view.center.x))
  const y = Math.min(bounds.maxY, Math.max(bounds.minY, view.center.y))
  if (x === view.center.x && y === view.center.y) return view
  return { ...view, center: { x, y } }
}
