import { describe, expect, it } from 'vitest'
import {
  defaultPanelLayout,
  PANEL_IDS,
  PANEL_LAYOUT_VERSION,
  parsePanelLayout,
  raisePanel,
  serializePanelLayout,
} from '#shared/utils/client/hud'

const BOUNDS = { width: 1440, height: 820 }

const inside = (r: { x: number; y: number; width: number; height: number }) =>
  r.x >= 0 && r.y >= 0 && r.x + r.width <= BOUNDS.width && r.y + r.height <= BOUNDS.height

describe('defaultPanelLayout', () => {
  it('places every panel inside the bounds, stacked in registry order', () => {
    const layout = defaultPanelLayout(BOUNDS)
    expect(layout.version).toBe(PANEL_LAYOUT_VERSION)
    expect(Object.keys(layout.panels).sort()).toEqual([...PANEL_IDS].sort())
    expect(layout.order).toEqual([...PANEL_IDS])
    expect(PANEL_IDS.filter((id) => !inside(layout.panels[id].rect))).toEqual([])
  })

  it('opens the map bottom-left, the vote or segment on the right, attitude and speed top-left', () => {
    const { panels } = defaultPanelLayout(BOUNDS)
    const open = PANEL_IDS.filter((id) => panels[id].open).sort()
    expect(open).toEqual(['attitude', 'map2d', 'segment', 'speed', 'vote'])
    const { map2d, vote, segment, attitude, speed } = panels
    expect(segment.rect).toEqual(vote.rect)
    expect(map2d.rect.x).toBeLessThan(BOUNDS.width / 4)
    expect(map2d.rect.y + map2d.rect.height).toBeGreaterThan(BOUNDS.height * 0.9)
    expect(vote.rect.x + vote.rect.width).toBeGreaterThan(BOUNDS.width * 0.9)
    for (const top of [attitude, speed]) {
      expect(top.rect.y).toBeLessThan(BOUNDS.height / 4)
      expect(top.rect.x).toBeLessThan(BOUNDS.width / 2)
    }
    // The top-left pair and the map do not cover one another.
    expect(attitude.rect.x + attitude.rect.width).toBeLessThanOrEqual(speed.rect.x)
    expect(attitude.rect.y + attitude.rect.height).toBeLessThanOrEqual(map2d.rect.y)
  })
})

describe('parsePanelLayout', () => {
  it('round-trips a layout through its serialized form', () => {
    const layout = defaultPanelLayout(BOUNDS)
    layout.panels.clock = {
      open: true,
      minimised: true,
      rect: { x: 400, y: 50, width: 260, height: 180 },
    }
    layout.panels.vote.open = false
    layout.order = raisePanel(layout.order, 'clock')
    expect(parsePanelLayout(serializePanelLayout(layout), BOUNDS)).toEqual(layout)
  })

  it('discards a layout saved under another version', () => {
    const old = defaultPanelLayout(BOUNDS)
    old.panels.map2d.open = false
    const raw = JSON.parse(serializePanelLayout(old)) as { version: number }
    raw.version = PANEL_LAYOUT_VERSION - 1
    expect(parsePanelLayout(JSON.stringify(raw), BOUNDS)).toEqual(defaultPanelLayout(BOUNDS))
  })

  it('falls back to the defaults for nothing stored or garbage', () => {
    expect(parsePanelLayout(null, BOUNDS)).toEqual(defaultPanelLayout(BOUNDS))
    expect(parsePanelLayout('{not json', BOUNDS)).toEqual(defaultPanelLayout(BOUNDS))
    expect(parsePanelLayout('[]', BOUNDS)).toEqual(defaultPanelLayout(BOUNDS))
  })

  it('keeps valid panels and defaults the invalid, missing or unknown ones', () => {
    const saved = defaultPanelLayout(BOUNDS)
    saved.panels.speed.rect = { x: 700, y: 300, width: 300, height: 200 }
    const raw = JSON.parse(serializePanelLayout(saved)) as {
      panels: Record<string, unknown>
      order: string[]
    }
    raw.panels.attitude = { open: 'yes', minimised: false, rect: { x: 1 } }
    delete raw.panels.slip
    raw.panels.gone = { open: true, minimised: false, rect: { x: 0, y: 0, width: 1, height: 1 } }
    raw.order = ['gone', 'speed', 'speed']
    const parsed = parsePanelLayout(JSON.stringify(raw), BOUNDS)
    const defaults = defaultPanelLayout(BOUNDS)
    expect(parsed.panels.speed.rect).toEqual({ x: 700, y: 300, width: 300, height: 200 })
    expect(parsed.panels.attitude).toEqual(defaults.panels.attitude)
    expect(parsed.panels.slip).toEqual(defaults.panels.slip)
    expect(Object.keys(parsed.panels).sort()).toEqual([...PANEL_IDS].sort())
    // Known ids once each, the stored ones first.
    expect(parsed.order[0]).toBe('speed')
    expect([...parsed.order].sort()).toEqual([...PANEL_IDS].sort())
  })
})

describe('raisePanel', () => {
  it('moves the panel to the top of the stack', () => {
    expect(raisePanel(['map2d', 'vote', 'clock'], 'map2d')).toEqual(['vote', 'clock', 'map2d'])
    expect(raisePanel(['vote', 'clock'], 'clock')).toEqual(['vote', 'clock'])
  })
})
