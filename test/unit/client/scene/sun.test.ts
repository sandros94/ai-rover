import { describe, expect, it } from 'vitest'
import { DEFAULT_LATITUDE_DEG, skyLighting, sunPosition } from '#shared/utils/client/scene/sun'

describe('sunPosition', () => {
  it('stands above the horizon at noon, due south of a northern site, and below it at midnight', () => {
    const noon = sunPosition(0.5)
    expect(noon.elevationDeg).toBeCloseTo(90 - DEFAULT_LATITUDE_DEG, 6)
    expect(noon.azimuthDeg).toBeCloseTo(180, 6)
    expect(sunPosition(0).elevationDeg).toBeLessThan(-60)
    expect(sunPosition(1).elevationDeg).toBeCloseTo(sunPosition(0).elevationDeg, 9)
  })

  it('rises in the east and sets in the west', () => {
    const rise = sunPosition(0.25)
    expect(rise.elevationDeg).toBeCloseTo(0, 6)
    expect(rise.azimuthDeg).toBeCloseTo(90, 6)
    expect(rise.direction.x).toBeCloseTo(1, 6)
    const set = sunPosition(0.75)
    expect(set.azimuthDeg).toBeCloseTo(270, 6)
    expect(sunPosition(0.3).elevationDeg).toBeGreaterThan(0)
    expect(sunPosition(0.2).elevationDeg).toBeLessThan(0)
  })

  it('returns a unit direction whose height is the sine of the elevation', () => {
    for (const f of [0.1, 0.33, 0.5, 0.71, 0.9]) {
      const { direction: d, elevationDeg } = sunPosition(f, -30)
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9)
      expect(d.z).toBeCloseTo(Math.sin((elevationDeg * Math.PI) / 180), 9)
    }
  })

  it('refuses a non-finite time', () => {
    expect(() => sunPosition(Number.NaN)).toThrow(/finite/)
  })
})

describe('skyLighting', () => {
  const range = Array.from({ length: 217 }, (_, k) => -18 + k * 0.5)

  it('lowers the exposure, never raising it, as the sun climbs', () => {
    for (let k = 1; k < range.length; k++) {
      expect(skyLighting(range[k]!).exposure).toBeLessThanOrEqual(
        skyLighting(range[k - 1]!).exposure,
      )
    }
    expect(skyLighting(90).exposure).toBe(1)
  })

  it('has no direct sun below the horizon and brightens it as it climbs', () => {
    expect(skyLighting(-5).sun.intensity).toBe(0)
    for (let k = 1; k < range.length; k++) {
      expect(skyLighting(range[k]!).sun.intensity).toBeGreaterThanOrEqual(
        skyLighting(range[k - 1]!).sun.intensity,
      )
    }
  })

  it('keeps dusk dim and night dark after exposure', () => {
    // Light on level ground times exposure: what the camera makes of the ground.
    const seen = (e: number) => {
      const l = skyLighting(e)
      return (
        (l.sun.intensity * Math.max(0, Math.sin((e * Math.PI) / 180)) + l.sky.intensity) *
        l.exposure
      )
    }
    expect(seen(0)).toBeLessThan(seen(45) / 1.5)
    expect(seen(0)).toBeGreaterThan(seen(-6))
    expect(seen(-18)).toBeLessThan(seen(45) / 4)
    expect(seen(-18)).toBeGreaterThan(0)
  })

  it('softens shadows towards the horizon', () => {
    expect(skyLighting(2).shadowRadius).toBeGreaterThan(skyLighting(60).shadowRadius)
  })

  it('paints a butterscotch day sky and a blue glow around a setting sun', () => {
    const day = skyLighting(60).zenith
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(day.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g!)
    expect(g).toBeGreaterThan(b!)
    const glow = skyLighting(0).glow
    expect(Number.parseInt(glow.slice(5, 7), 16)).toBeGreaterThan(
      Number.parseInt(glow.slice(1, 3), 16),
    )
  })

  it('holds the night key below its range', () => {
    expect(skyLighting(-80)).toEqual(skyLighting(-18))
  })
})
