import { describe, expect, it } from 'vitest'
import {
  FOG_FILL,
  groundRgb,
  HILLSHADE_EXAGGERATION,
  hillshadeAt,
  LUMA,
  reliefLight,
  reliefRgb,
  rgbHex,
  SCENE_COLORS,
  SEEN_STOPS,
  srgbToLinear,
} from '#shared/utils/client/scene/palette'
import type { Rgb } from '#shared/utils/client/scene/palette'

const luma = ([r, g, b]: readonly number[]) => LUMA[0] * r! + LUMA[1] * g! + LUMA[2] * b!

describe('reliefRgb', () => {
  it('is a hypsometric tint whose lightness rises with height', () => {
    let previous = reliefRgb(0)
    for (let k = 1; k <= 100; k++) {
      const next = reliefRgb(k / 100)
      expect(luma(next)).toBeGreaterThan(luma(previous))
      previous = next
    }
  })

  it('shifts hue along the ramp, not only brightness', () => {
    const [r0, g0, b0] = reliefRgb(0)
    const [r1, g1, b1] = reliefRgb(1)
    // Low ground is red-dominant rust, high ground a paler, bluer sand.
    expect(b0 / r0).toBeLessThan(b1 / r1 - 0.2)
    expect(g0 / r0).toBeLessThan(g1 / r1 - 0.2)
  })

  it('clamps outside [0, 1]', () => {
    expect(reliefRgb(-2)).toEqual(reliefRgb(0))
    expect(reliefRgb(3)).toEqual(reliefRgb(1))
  })
})

describe('hillshadeAt', () => {
  it('exaggerates slopes by the default factor', () => {
    expect(HILLSHADE_EXAGGERATION).toBe(2.5)
    expect(hillshadeAt(0.1, -0.05)).toBeCloseTo(hillshadeAt(0.25, -0.125, 1), 12)
    expect(hillshadeAt(0.1, -0.05, 3)).toBeCloseTo(hillshadeAt(0.3, -0.15, 1), 12)
  })

  it('lights flat ground at the sine of the sun altitude', () => {
    expect(hillshadeAt(0, 0)).toBeCloseTo(Math.SQRT1_2, 12)
  })
})

describe('reliefLight', () => {
  it('keeps a floor in full shade and brightens with the hillshade', () => {
    expect(reliefLight(0)).toBeCloseTo(0.25)
    expect(reliefLight(1)).toBeCloseTo(1.2)
    expect(reliefLight(0.6)).toBeGreaterThan(reliefLight(0.5))
  })
})

describe('FOG_FILL', () => {
  it('is light in light mode and dark in dark mode', () => {
    expect(luma(FOG_FILL.light)).toBeGreaterThan(180)
    expect(luma(FOG_FILL.dark)).toBeLessThan(60)
  })
})

describe('rgbHex', () => {
  it('formats rounded, clamped channels', () => {
    expect(rgbHex([255, 0, 16.4])).toBe('#ff0010')
    expect(rgbHex([300, -4, 170.6])).toBe('#ff00ab')
  })
})

describe('srgbToLinear', () => {
  it('maps the 8-bit ends to 0 and 1 and darkens the midtones', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(255)).toBeCloseTo(1, 6)
    expect(srgbToLinear(128)).toBeCloseTo(0.2158, 3)
  })
})

/** CIE L*a*b* of an 8-bit sRGB colour (D65). */
function lab([r, g, b]: readonly number[]): [number, number, number] {
  const R = srgbToLinear(r!)
  const G = srgbToLinear(g!)
  const B = srgbToLinear(b!)
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116)
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
  const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
  const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}

/** CIE76 colour difference. */
function deltaE(a: readonly number[], b: readonly number[]): number {
  const p = lab(a)
  const q = lab(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

const rgb = (hex: string): Rgb => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as Rgb

describe('SCENE_COLORS.marker', () => {
  const { marker } = SCENE_COLORS
  const grounds = [
    ...Array.from({ length: 41 }, (_, k) => groundRgb(k / 40, true)),
    ...Array.from({ length: 41 }, (_, k) => groundRgb(k / 40, false)),
    FOG_FILL.light,
    FOG_FILL.dark,
  ]
  const nearest = (hex: string) => Math.min(...grounds.map((ground) => deltaE(rgb(hex), ground)))

  it('keeps the thin white post apart from every ground and fog', () => {
    expect(nearest(marker.post)).toBeGreaterThan(12)
  })

  it('keeps spheres and flags clearly apart from every ground and fog', () => {
    for (const hex of [...Object.values(marker.sphere), ...Object.values(marker.flag)]) {
      expect(nearest(hex)).toBeGreaterThan(18)
    }
  })

  it('tells the current stop and the destination from the rest', () => {
    expect(deltaE(rgb(marker.sphere.current), rgb(marker.sphere.past))).toBeGreaterThan(40)
    expect(deltaE(rgb(marker.flag.destination), rgb(marker.flag.goal))).toBeGreaterThan(40)
  })

  it('draws the contact disc darker than any ground', () => {
    for (const ground of grounds) expect(luma(rgb(marker.contact))).toBeLessThan(luma(ground))
  })
})

describe('groundRgb', () => {
  const ramp = (inSight: boolean) =>
    Array.from({ length: 41 }, (_, k) => groundRgb(k / 40, inSight))
  const chroma = (rgb: readonly number[]) => Math.hypot(lab(rgb)[1], lab(rgb)[2])

  it('is the relief ramp in sight and the seen ramp out of it', () => {
    for (const t of [0, 0.3, 0.5, 1]) expect(groundRgb(t, true)).toEqual(reliefRgb(t))
    expect(groundRgb(0, false)).toEqual([...SEEN_STOPS[0]!])
    expect(groundRgb(1, false)).toEqual([...SEEN_STOPS.at(-1)!])
  })

  it('keeps the seen ramp in order of lightness, so it still reads as relief', () => {
    const seen = ramp(false)
    for (let k = 1; k < seen.length; k++) expect(luma(seen[k]!)).toBeGreaterThan(luma(seen[k - 1]!))
  })

  it('desaturates ground seen before well below the ground in sight', () => {
    const inSight = ramp(true)
    const seen = ramp(false)
    for (let k = 0; k < seen.length; k++) {
      expect(chroma(seen[k]!)).toBeLessThan(chroma(inSight[k]!))
      expect(chroma(seen[k]!)).toBeLessThan(16)
    }
  })

  it('tells each ground state apart: in sight, seen before and fog', () => {
    const inSight = ramp(true)
    const seen = ramp(false)
    for (let k = 0; k < seen.length; k++) {
      expect(deltaE(seen[k]!, inSight[k]!)).toBeGreaterThan(15)
      for (const fog of [FOG_FILL.light, FOG_FILL.dark]) {
        expect(deltaE(seen[k]!, fog)).toBeGreaterThan(14)
      }
    }
  })
})
