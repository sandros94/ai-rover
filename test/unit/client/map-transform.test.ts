import { describe, expect, it } from 'vitest'
import type { MapView } from '#shared/utils/client/map-transform'
import {
  clampView,
  fitView,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAbout,
} from '#shared/utils/client/map-transform'

const view: MapView = { center: { x: 120, y: -40 }, scale: 2.5, width: 800, height: 600 }
const bounds = { minX: -500, minY: -500, maxX: 500, maxY: 500 }

describe('map transform', () => {
  it('puts the view centre at the middle of the screen, north up', () => {
    expect(worldToScreen(view, view.center)).toEqual({ x: 400, y: 300 })
    const north = worldToScreen(view, { x: 120, y: -30 })
    expect(north.x).toBe(400)
    expect(north.y).toBe(300 - 25)
    const east = worldToScreen(view, { x: 130, y: -40 })
    expect(east).toEqual({ x: 425, y: 300 })
  })

  it('round-trips world and screen points', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: -312.25, y: 77.5 },
      { x: 499.9, y: -499.9 },
    ]) {
      const back = screenToWorld(view, worldToScreen(view, point))
      expect(back.x).toBeCloseTo(point.x, 9)
      expect(back.y).toBeCloseTo(point.y, 9)
    }
    for (const pixel of [
      { x: 0, y: 0 },
      { x: 13, y: 590 },
    ]) {
      const back = worldToScreen(view, screenToWorld(view, pixel))
      expect(back.x).toBeCloseTo(pixel.x, 9)
      expect(back.y).toBeCloseTo(pixel.y, 9)
    }
  })

  it('zooms about a point and keeps that point fixed', () => {
    const at = { x: 610, y: 95 }
    const under = screenToWorld(view, at)
    for (const factor of [2, 0.5, 1.37]) {
      const zoomed = zoomAbout(view, { at, factor, minScale: 0.1, maxScale: 50 })
      expect(zoomed.scale).toBeCloseTo(view.scale * factor, 12)
      const still = worldToScreen(zoomed, under)
      expect(still.x).toBeCloseTo(at.x, 9)
      expect(still.y).toBeCloseTo(at.y, 9)
    }
  })

  it('clamps the zoom and still keeps the point fixed at the clamped scale', () => {
    const at = { x: 100, y: 100 }
    const under = screenToWorld(view, at)
    const zoomed = zoomAbout(view, { at, factor: 100, minScale: 0.1, maxScale: 8 })
    expect(zoomed.scale).toBe(8)
    const still = worldToScreen(zoomed, under)
    expect(still.x).toBeCloseTo(at.x, 9)
    expect(still.y).toBeCloseTo(at.y, 9)
    expect(zoomAbout(view, { at, factor: 1e-6, minScale: 0.1, maxScale: 8 }).scale).toBe(0.1)
  })

  it('pans with the pointer: the ground under it follows the drag', () => {
    const from = { x: 300, y: 200 }
    const under = screenToWorld(view, from)
    const panned = panBy(view, { dx: 40, dy: -25 })
    const moved = worldToScreen(panned, under)
    expect(moved.x).toBeCloseTo(from.x + 40, 9)
    expect(moved.y).toBeCloseTo(from.y - 25, 9)
  })

  it('keeps the view centre inside the bounds', () => {
    const far = panBy(view, { dx: -1e6, dy: -1e6 })
    const clamped = clampView(far, bounds)
    expect(clamped.center).toEqual({ x: 500, y: -500 })
    expect(clampView(view, bounds)).toEqual(view)
    const other = clampView(panBy(view, { dx: 1e6, dy: 1e6 }), bounds)
    expect(other.center).toEqual({ x: -500, y: 500 })
  })

  it('fits the bounds inside the viewport with padding', () => {
    const fitted = fitView(bounds, { width: 800, height: 600, padding: 20 })
    expect(fitted.center).toEqual({ x: 0, y: 0 })
    expect(fitted.scale).toBeCloseTo(560 / 1000, 12)
    const corner = worldToScreen(fitted, { x: -500, y: 500 })
    expect(corner.y).toBeCloseTo(20, 9)
    expect(corner.x).toBeCloseTo(400 - 280, 9)
  })

  it('refuses a non-positive viewport or zoom factor', () => {
    expect(() => fitView(bounds, { width: 0, height: 600 })).toThrow(/width/)
    expect(() =>
      zoomAbout(view, { at: { x: 0, y: 0 }, factor: 0, minScale: 0.1, maxScale: 8 }),
    ).toThrow(/factor/)
  })
})
