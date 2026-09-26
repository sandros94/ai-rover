import { describe, expect, it } from 'vitest'
import {
  clampRect,
  dragRect,
  PANEL_MARGIN_PX,
  PANEL_MIN_SIZE,
  PANEL_SNAP_PX,
  resizeRect,
  snapRect,
} from '#shared/utils/client/hud'

const BOUNDS = { width: 1200, height: 800 }
const rect = { x: 100, y: 100, width: 300, height: 200 }

describe('clampRect', () => {
  it('keeps a rect that fits where it is', () => {
    expect(clampRect(rect, BOUNDS)).toEqual(rect)
  })

  it('moves a rect back inside the bounds on every side', () => {
    expect(clampRect({ ...rect, x: -50, y: -20 }, BOUNDS)).toEqual({ ...rect, x: 0, y: 0 })
    expect(clampRect({ ...rect, x: 1100, y: 700 }, BOUNDS)).toEqual({ ...rect, x: 900, y: 600 })
  })

  it('grows to the minimum size and shrinks to the bounds', () => {
    expect(clampRect({ ...rect, width: 10, height: 10 }, BOUNDS)).toMatchObject(PANEL_MIN_SIZE)
    expect(clampRect({ x: 0, y: 0, width: 2000, height: 900 }, BOUNDS)).toEqual({
      x: 0,
      y: 0,
      ...BOUNDS,
    })
    // Bounds smaller than the minimum win: the panel never leaves the viewport.
    expect(clampRect(rect, { width: 150, height: 90 })).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 90,
    })
  })
})

describe('snapRect', () => {
  it('snaps an edge near a side of the bounds to the margin', () => {
    const near = { ...rect, x: PANEL_MARGIN_PX + PANEL_SNAP_PX - 1, y: 3 }
    expect(snapRect(near, BOUNDS)).toMatchObject({ x: PANEL_MARGIN_PX, y: PANEL_MARGIN_PX })
    const right = { ...rect, x: BOUNDS.width - rect.width - PANEL_MARGIN_PX - 5 }
    expect(snapRect(right, BOUNDS).x).toBe(BOUNDS.width - rect.width - PANEL_MARGIN_PX)
    const bottom = { ...rect, y: BOUNDS.height - rect.height - 2 }
    expect(snapRect(bottom, BOUNDS).y).toBe(BOUNDS.height - rect.height - PANEL_MARGIN_PX)
  })

  it('leaves a rect away from the sides alone', () => {
    expect(snapRect(rect, BOUNDS)).toEqual(rect)
  })
})

describe('dragRect', () => {
  it('moves by the pointer delta', () => {
    expect(dragRect(rect, { x: 40, y: -30 }, BOUNDS)).toEqual({ ...rect, x: 140, y: 70 })
  })

  it('stops at the bounds', () => {
    expect(dragRect(rect, { x: -500, y: -500 }, BOUNDS)).toMatchObject({ x: 0, y: 0 })
    expect(dragRect(rect, { x: 5000, y: 5000 }, BOUNDS)).toMatchObject({ x: 900, y: 600 })
    expect(dragRect(rect, { x: 5000, y: 0 }, BOUNDS)).toMatchObject({ width: 300, height: 200 })
  })

  it('snaps to the edges on the way', () => {
    expect(dragRect(rect, { x: -85, y: 0 }, BOUNDS).x).toBe(PANEL_MARGIN_PX)
  })
})

describe('resizeRect', () => {
  it('moves the right and bottom edges from the corner handle', () => {
    expect(resizeRect(rect, { x: 50, y: 20 }, BOUNDS, { handle: { x: 1, y: 1 } })).toEqual({
      ...rect,
      width: 350,
      height: 220,
    })
  })

  it('moves the left edge keeping the right one', () => {
    expect(resizeRect(rect, { x: -40, y: 0 }, BOUNDS, { handle: { x: -1, y: 0 } })).toEqual({
      ...rect,
      x: 60,
      width: 340,
    })
  })

  it('never goes below the minimum size', () => {
    const shrunk = resizeRect(rect, { x: -1000, y: -1000 }, BOUNDS, { handle: { x: 1, y: 1 } })
    expect(shrunk).toEqual({ ...rect, ...PANEL_MIN_SIZE })
    const fromLeft = resizeRect(rect, { x: 1000, y: 0 }, BOUNDS, { handle: { x: -1, y: 0 } })
    expect(fromLeft.width).toBe(PANEL_MIN_SIZE.width)
    expect(fromLeft.x + fromLeft.width).toBe(rect.x + rect.width)
  })

  it('never grows past the bounds', () => {
    const grown = resizeRect(rect, { x: 5000, y: 5000 }, BOUNDS, { handle: { x: 1, y: 1 } })
    expect(grown).toEqual({ x: 100, y: 100, width: 1100, height: 700 })
    const left = resizeRect(rect, { x: -5000, y: 0 }, BOUNDS, { handle: { x: -1, y: 0 } })
    expect(left).toEqual({ ...rect, x: 0, width: 400 })
  })

  it('leaves an axis without a handle alone', () => {
    expect(resizeRect(rect, { x: 0, y: 80 }, BOUNDS, { handle: { x: 1, y: 0 } })).toEqual(rect)
  })
})
