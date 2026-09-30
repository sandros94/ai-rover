import { describe, expect, it } from 'vitest'
import type { SceneDevice } from '#shared/utils/client/scene/quality'
import {
  defaultTier,
  isSceneTier,
  parseQualityChoice,
  qualityFor,
  resolveQuality,
  SCENE_TIERS,
  serializeQualityChoice,
} from '#shared/utils/client/scene/quality'

describe('qualityFor', () => {
  it('names its tier and spends less, knob by knob, from high to low', () => {
    const [high, medium, low] = SCENE_TIERS.map(qualityFor)
    expect([high!.tier, medium!.tier, low!.tier]).toEqual(['high', 'medium', 'low'])
    for (const [more, less] of [
      [high!, medium!],
      [medium!, low!],
    ] as const) {
      expect(less.maxDpr).toBeLessThanOrEqual(more.maxDpr)
      expect(less.frameCap).toBeLessThanOrEqual(more.frameCap)
      expect(less.shadowMapSize).toBeLessThanOrEqual(more.shadowMapSize)
      expect(less.casterRangeM).toBeLessThanOrEqual(more.casterRangeM)
      expect(less.roverLodM!).toBeLessThanOrEqual(more.roverLodM!)
    }
  })

  it('sets every knob explicitly on every tier', () => {
    for (const tier of SCENE_TIERS) {
      const quality = qualityFor(tier)
      expect(Object.keys(quality).sort()).toEqual(
        [
          'casterRangeM',
          'frameCap',
          'maxDpr',
          'roverLodM',
          'shadowMapSize',
          'shadows',
          'tier',
        ].sort(),
      )
      expect(['full', 'rover', 'off']).toContain(quality.shadows)
      expect(Math.log2(quality.shadowMapSize) % 1).toBe(0)
      expect(quality.frameCap).toBeGreaterThan(0)
    }
  })

  it('caps the frame rate at 120 on the high tier and 60 on the others', () => {
    expect(SCENE_TIERS.map((tier) => qualityFor(tier).frameCap)).toEqual([120, 60, 60])
  })

  it('returns a fresh object, so a caller cannot change a tier for everyone', () => {
    const quality = qualityFor('high')
    quality.maxDpr = 9
    expect(qualityFor('high').maxDpr).not.toBe(9)
  })
})

describe('isSceneTier', () => {
  it('accepts the tiers only', () => {
    expect(SCENE_TIERS.every(isSceneTier)).toBe(true)
    for (const value of ['ultra', '', null, undefined, 2, 'HIGH'])
      expect(isSceneTier(value)).toBe(false)
  })
})

describe('defaultTier', () => {
  const desktop: SceneDevice = { cores: 16, memoryGb: 8, touch: false, screenShortPx: 1080 }

  it('gives a current desktop the high tier, and one that does not report its memory too', () => {
    expect(defaultTier(desktop)).toBe('high')
    expect(defaultTier({ ...desktop, memoryGb: undefined })).toBe('high')
    expect(defaultTier({ ...desktop, cores: 8 })).toBe('high')
  })

  it('gives fewer than eight threads or less than 8 GB the medium tier on a desktop', () => {
    expect(defaultTier({ ...desktop, cores: 6 })).toBe('medium')
    expect(defaultTier({ ...desktop, memoryGb: 4 })).toBe('medium')
  })

  it('gives two cores or 2 GB the low tier, on any device', () => {
    expect(defaultTier({ ...desktop, cores: 2 })).toBe('low')
    expect(defaultTier({ ...desktop, memoryGb: 2 })).toBe('low')
    expect(defaultTier({ cores: 8, memoryGb: 2, touch: true, screenShortPx: 800 })).toBe('low')
  })

  it('gives a phone medium only with six cores and 4 GB, and a tablet medium', () => {
    const phone: SceneDevice = { cores: 8, memoryGb: 4, touch: true, screenShortPx: 390 }
    expect(defaultTier(phone)).toBe('medium')
    expect(defaultTier({ ...phone, cores: 4 })).toBe('low')
    expect(defaultTier({ ...phone, memoryGb: 3 })).toBe('low')
    expect(defaultTier({ ...phone, screenShortPx: 599 })).toBe('medium')
    expect(defaultTier({ ...phone, cores: 4, screenShortPx: 600 })).toBe('medium')
    expect(defaultTier({ ...phone, cores: 16, memoryGb: 8, screenShortPx: 1024 })).toBe('medium')
  })
})

describe('resolveQuality', () => {
  it("is the device's tier on auto and the chosen tier otherwise", () => {
    expect(resolveQuality({ tier: 'auto' }, 'low')).toEqual(qualityFor('low'))
    expect(resolveQuality({ tier: 'high' }, 'low')).toEqual(qualityFor('high'))
  })

  it("sets the shadows and frame cap chosen over the tier's, and nothing else", () => {
    expect(resolveQuality({ tier: 'high', shadows: 'off', frameCap: 30 }, 'low')).toEqual({
      ...qualityFor('high'),
      shadows: 'off',
      frameCap: 30,
    })
    expect(resolveQuality({ tier: 'auto', frameCap: 'display' }, 'medium').frameCap).toBe(Infinity)
    // Full shadows on the low tier: the ground near the rover casts.
    const low = resolveQuality({ tier: 'low', shadows: 'full' }, 'high')
    expect(low.shadows).toBe('full')
    expect(low.casterRangeM).toBeGreaterThan(0)
  })
})

describe('the stored choice', () => {
  it('round-trips, storing nothing for the default', () => {
    for (const choice of [
      { tier: 'low' as const },
      { tier: 'auto' as const, shadows: 'rover' as const },
      { tier: 'high' as const, shadows: 'off' as const, frameCap: 'display' as const },
      { tier: 'medium' as const, frameCap: 120 as const },
    ]) {
      expect(parseQualityChoice(serializeQualityChoice(choice))).toEqual(choice)
    }
    expect(serializeQualityChoice({ tier: 'auto' })).toBeNull()
    expect(parseQualityChoice(null)).toEqual({ tier: 'auto' })
  })

  it('reads a bare tier name, and drops what is not a known value', () => {
    expect(parseQualityChoice('medium')).toEqual({ tier: 'medium' })
    expect(parseQualityChoice('ultra')).toEqual({ tier: 'auto' })
    expect(parseQualityChoice('{"tier":"low","shadows":"soft","frameCap":45}')).toEqual({
      tier: 'low',
    })
    expect(parseQualityChoice('[1]')).toEqual({ tier: 'auto' })
  })
})
