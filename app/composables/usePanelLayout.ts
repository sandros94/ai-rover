import type {
  PanelId,
  PanelLayout,
  PanelPlacement,
  PanelRect,
  PanelSize,
} from '#shared/utils/client/hud'
import {
  defaultPanelLayout,
  PANEL_LAYOUT_KEY,
  parsePanelLayout,
  raisePanel,
  serializePanelLayout,
} from '#shared/utils/client/hud'

/** How each panel names itself in its title bar and in the panels menu. */
export const PANEL_SPECS: Record<PanelId, { title: string; icon: string }> = {
  map2d: { title: '2D map', icon: 'i-lucide-map' },
  vote: { title: 'Next destination', icon: 'i-lucide-vote' },
  attitude: { title: 'Attitude', icon: 'i-lucide-rotate-3d' },
  speed: { title: 'Speed', icon: 'i-lucide-gauge' },
  clock: { title: 'Clock', icon: 'i-lucide-clock' },
  events: { title: 'Drive log', icon: 'i-lucide-list' },
  slip: { title: 'Slip', icon: 'i-lucide-waves' },
  reveals: { title: 'Ground revealed', icon: 'i-lucide-scan-eye' },
  planner: { title: 'Planner', icon: 'i-lucide-route' },
  journey: { title: 'Journey', icon: 'i-lucide-flag' },
  segment: { title: 'This segment', icon: 'i-lucide-scale' },
  details: { title: 'Details', icon: 'i-lucide-info' },
}

/** Storage writes wait for this quiet time, so a burst of changes writes once. */
const SAVE_DELAY_MS = 250

/**
 * The floating panels' layout, shared by every HUD of the app and kept in `localStorage` under
 * {@link PANEL_LAYOUT_KEY}. It is empty until {@link load} is given the HUD area's size, since the
 * default arrangement depends on it. Storage that is blocked or absent only means the layout is
 * not remembered.
 */
export function usePanelLayout() {
  const layout = useState<PanelLayout | null>('jev-rover:panels', () => null)
  let timer: ReturnType<typeof setTimeout> | undefined

  function write(): void {
    clearTimeout(timer)
    timer = undefined
    if (!layout.value) return
    try {
      localStorage.setItem(PANEL_LAYOUT_KEY, serializePanelLayout(layout.value))
    } catch {
      // Storage unavailable: the layout lasts for this page only.
    }
  }

  function save(): void {
    clearTimeout(timer)
    timer = setTimeout(write, SAVE_DELAY_MS)
  }
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (timer !== undefined) write()
    })
  }

  /** Reads the stored layout once, over the defaults for an area of `bounds`. */
  function load(bounds: PanelSize): void {
    if (layout.value || bounds.width <= 0 || bounds.height <= 0) return
    let raw: string | null = null
    try {
      raw = localStorage.getItem(PANEL_LAYOUT_KEY)
    } catch {
      // Storage unavailable: start from the defaults.
    }
    layout.value = parsePanelLayout(raw, bounds)
  }

  function update(id: PanelId, change: Partial<PanelPlacement>): void {
    const current = layout.value
    if (!current) return
    layout.value = {
      ...current,
      panels: { ...current.panels, [id]: { ...current.panels[id], ...change } },
    }
    save()
  }

  function raise(id: PanelId): void {
    const current = layout.value
    if (!current || current.order.at(-1) === id) return
    layout.value = { ...current, order: raisePanel(current.order, id) }
    save()
  }

  return {
    layout,
    load,
    raise,
    open(id: PanelId): void {
      update(id, { open: true, minimised: false })
      raise(id)
    },
    close(id: PanelId): void {
      update(id, { open: false })
    },
    minimise(id: PanelId, minimised: boolean): void {
      update(id, { minimised })
    },
    move(id: PanelId, rect: PanelRect): void {
      update(id, { rect })
    },
    /** Back to the first-visit arrangement for an area of `bounds`. */
    reset(bounds: PanelSize): void {
      layout.value = defaultPanelLayout(bounds)
      save()
    },
  }
}
