import type { PanelRect, PanelSize } from './panel-geometry'
import { PANEL_MARGIN_PX } from './panel-geometry'

/**
 * Every panel the HUD can float, bottom of the stack first. Closed set: a page offers a subset,
 * and the stored layout is keyed by these ids.
 */
export const PANEL_IDS = [
  'map2d',
  'vote',
  'attitude',
  'speed',
  'clock',
  'events',
  'slip',
  'reveals',
  'planner',
  'journey',
  'segment',
  'details',
] as const

export type PanelId = (typeof PANEL_IDS)[number]

/** Browser storage key of the floating panels' layout. */
export const PANEL_LAYOUT_KEY = 'ai-rover:panels'
/** Bumped when the stored shape or the default arrangement changes; older layouts are dropped. */
export const PANEL_LAYOUT_VERSION = 1

export interface PanelPlacement {
  open: boolean
  /** Only the title bar shows. */
  minimised: boolean
  rect: PanelRect
}

export interface PanelLayout {
  version: number
  panels: Record<PanelId, PanelPlacement>
  /** Stacking order, bottom first: the last one is drawn on top. */
  order: PanelId[]
}

/** Kept clear under the 2D map's first place: the site credit, 24 px tall over the panel margin. */
const CREDIT_STRIP_PX = 32

/** Opened on a first visit. */
const OPEN_BY_DEFAULT: readonly PanelId[] = ['map2d', 'vote', 'segment', 'attitude', 'speed']

/**
 * The arrangement of a first visit in an area of `bounds`: attitude and speed side by side at
 * the top left, the 2D map at the bottom left above the site credit, the vote (or a replay's
 * segment) down the right with a focused object's details over its foot; the rest in a cascade in
 * the middle, closed until asked for. The details panel shows while an object is focused,
 * whatever its `open` flag says.
 */
export function defaultPanelLayout(bounds: PanelSize): PanelLayout {
  const m = PANEL_MARGIN_PX
  const { width: w, height: h } = bounds
  const at = (x: number, y: number, width: number, height: number): PanelRect => {
    const fitW = Math.min(width, Math.max(0, w - 2 * m))
    const fitH = Math.min(height, Math.max(0, h - 2 * m))
    return {
      x: Math.max(0, Math.min(x, w - fitW)),
      y: Math.max(0, Math.min(y, h - fitH)),
      width: fitW,
      height: fitH,
    }
  }
  const map = Math.min(360, Math.round(h / 2))
  const fixed: Partial<Record<PanelId, PanelRect>> = {
    attitude: at(m, m, 340, 270),
    speed: at(m + 340 + m, m, 300, 270),
    map2d: at(m, h - m - CREDIT_STRIP_PX - map, map, map),
    vote: at(w - m - 380, m, 380, Math.min(640, h - 2 * m)),
    // A replay's own panel, where the live page has the vote.
    segment: at(w - m - 380, m, 380, Math.min(640, h - 2 * m)),
    // A focused object's, over the foot of that column: the focused object is in the middle.
    details: at(w - m - 380, h - m - 360, 380, 360),
  }
  const panels = {} as Record<PanelId, PanelPlacement>
  let cascade = 0
  for (const id of PANEL_IDS) {
    const rect =
      fixed[id] ?? at(Math.round(w / 2 - 160) + 28 * cascade, m + 28 * cascade++, 320, 280)
    panels[id] = { open: OPEN_BY_DEFAULT.includes(id), minimised: false, rect }
  }
  return { version: PANEL_LAYOUT_VERSION, panels, order: [...PANEL_IDS] }
}

const isPanelId = (value: unknown): value is PanelId =>
  typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function placement(value: unknown): PanelPlacement | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { open, minimised, rect } = value as Record<string, unknown>
  if (typeof open !== 'boolean' || typeof minimised !== 'boolean') return undefined
  if (!rect || typeof rect !== 'object') return undefined
  const { x, y, width, height } = rect as Record<string, unknown>
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return undefined
  return { open, minimised, rect: { x, y, width, height } }
}

/**
 * The layout stored as `raw`, over the defaults for `bounds`: nothing stored, anything that is
 * not a layout, or a layout of another {@link PANEL_LAYOUT_VERSION} gives the defaults; a panel
 * whose entry is missing or malformed gets its default. Rects are kept as stored: the HUD fits
 * them to the area when drawing, so a window made small and large again gets them back.
 */
export function parsePanelLayout(raw: string | null, bounds: PanelSize): PanelLayout {
  const defaults = defaultPanelLayout(bounds)
  let stored: unknown
  try {
    stored = raw === null ? undefined : JSON.parse(raw)
  } catch {
    return defaults
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults
  const { version, panels, order } = stored as Record<string, unknown>
  if (version !== PANEL_LAYOUT_VERSION) return defaults
  const entries = panels && typeof panels === 'object' ? (panels as Record<string, unknown>) : {}
  const result = { ...defaults.panels }
  for (const id of PANEL_IDS) {
    const own = Object.hasOwn(entries, id) ? placement(entries[id]) : undefined
    if (own) result[id] = own
  }
  const known = Array.isArray(order) ? order.filter(isPanelId) : []
  const stack = [...new Set([...known, ...PANEL_IDS.filter((id) => !known.includes(id))])]
  return { version: PANEL_LAYOUT_VERSION, panels: result, order: stack }
}

export function serializePanelLayout(layout: PanelLayout): string {
  return JSON.stringify(layout)
}

/** `order` with `id` moved to the top of the stack. */
export function raisePanel(order: readonly PanelId[], id: PanelId): PanelId[] {
  return [...order.filter((other) => other !== id), id]
}
