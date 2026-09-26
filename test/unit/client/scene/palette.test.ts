import { describe, expect, it } from 'vitest'
import { fogRgb, reliefLight, reliefRgb, srgbToLinear } from '#shared/utils/client/scene/palette'
import { FOG_DESATURATE, FOG_DIM, LUMA } from '#shared/utils/client/relief'

describe('reliefRgb', () => {
  it('rises in every channel from low to high ground', () => {
    let previous = reliefRgb(0)
    for (let k = 1; k <= 100; k++) {
      const next = reliefRgb(k / 100)
      for (let c = 0; c < 3; c++) expect(next[c]!).toBeGreaterThan(previous[c]!)
      previous = next
    }
  })

  it('clamps outside [0, 1]', () => {
    expect(reliefRgb(-2)).toEqual(reliefRgb(0))
    expect(reliefRgb(3)).toEqual(reliefRgb(1))
  })
})

describe('reliefLight', () => {
  it('keeps a floor in full shade and brightens with the hillshade', () => {
    expect(reliefLight(0)).toBeCloseTo(0.25)
    expect(reliefLight(1)).toBeCloseTo(1.2)
    expect(reliefLight(0.6)).toBeGreaterThan(reliefLight(0.5))
  })
})

describe('fogRgb', () => {
  it('dims and greys a colour by the 2D map constants', () => {
    const [r, g, b] = fogRgb([200, 100, 50])
    const grey = LUMA[0] * 200 + LUMA[1] * 100 + LUMA[2] * 50
    expect(r).toBeCloseTo(FOG_DIM * (200 + FOG_DESATURATE * (grey - 200)))
    expect(g).toBeCloseTo(FOG_DIM * (100 + FOG_DESATURATE * (grey - 100)))
    expect(b).toBeCloseTo(FOG_DIM * (50 + FOG_DESATURATE * (grey - 50)))
  })
})

describe('srgbToLinear', () => {
  it('maps the 8-bit ends to 0 and 1 and darkens the midtones', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(255)).toBeCloseTo(1, 6)
    expect(srgbToLinear(128)).toBeCloseTo(0.2158, 3)
  })
})
