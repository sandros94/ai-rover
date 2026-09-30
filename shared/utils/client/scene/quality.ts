/*
 * How much the stop scene spends drawing itself: a tier per viewer, each an explicit set of knobs
 * the scene reads. Nothing in the scene moves faster than a few centimetres a second, so what a
 * tier mostly trades is how often and how finely the same picture is drawn again.
 */

export const SCENE_TIERS = ['high', 'medium', 'low'] as const
export type SceneTier = (typeof SCENE_TIERS)[number]

export interface SceneQuality {
  tier: SceneTier
  /**
   * What casts shadows: the ground near the camera target and the rover, the rover alone (the
   * ground still receives), or nothing, with no shadow map at all.
   */
  shadows: 'full' | 'rover' | 'off'
  /** Side of the square shadow map, texels. */
  shadowMapSize: number
  /**
   * Ground within this many metres of the camera target casts shadows; beyond, it only receives.
   * Read only with `full` shadows.
   */
  casterRangeM: number
  /** Device pixels per CSS pixel at most. */
  maxDpr: number
  /**
   * Frames a second at most while nobody handles the view; `Infinity` for the display's rate.
   * Orbiting, zooming, the pointer over the scene and a focus easing in draw at the display's
   * rate.
   */
  frameCap: number
  /** Camera distance beyond which the rover draws its low-poly model, metres; `null` never. */
  roverLodM: number | null
}

const TIERS: Record<SceneTier, Omit<SceneQuality, 'tier'>> = {
  high: {
    shadows: 'full',
    shadowMapSize: 2048,
    // The shadow square's largest half side: every chunk it covers casts.
    casterRangeM: 120,
    maxDpr: 2,
    frameCap: 120,
    roverLodM: 60,
  },
  medium: {
    shadows: 'full',
    shadowMapSize: 2048,
    casterRangeM: 64,
    maxDpr: 1.5,
    frameCap: 60,
    roverLodM: 40,
  },
  low: {
    shadows: 'rover',
    shadowMapSize: 1024,
    // For full shadows chosen over the tier's: the ground right around the rover.
    casterRangeM: 32,
    maxDpr: 1,
    frameCap: 60,
    roverLodM: 20,
  },
}

export function qualityFor(tier: SceneTier): SceneQuality {
  return { tier, ...TIERS[tier] }
}

export function isSceneTier(value: unknown): value is SceneTier {
  return typeof value === 'string' && (SCENE_TIERS as readonly string[]).includes(value)
}

export const SHADOW_SETTINGS = [
  'full',
  'rover',
  'off',
] as const satisfies readonly SceneQuality['shadows'][]
/** Frame caps a viewer may choose; `display` draws at the display's rate. */
export const FRAME_CAP_SETTINGS = [30, 60, 120, 'display'] as const
export type FrameCapSetting = (typeof FRAME_CAP_SETTINGS)[number]

/**
 * A viewer's choice: a tier, or `auto` for the device's, and any knob set over the tier's. A
 * knob left out follows the tier.
 */
export interface QualityChoice {
  tier: SceneTier | 'auto'
  shadows?: SceneQuality['shadows']
  frameCap?: FrameCapSetting
}

/** The choice of a viewer who has chosen nothing. */
export const DEFAULT_QUALITY_CHOICE: QualityChoice = Object.freeze({ tier: 'auto' })

/** The quality `choice` sets on a device whose default tier is `deviceTier`. */
export function resolveQuality(choice: QualityChoice, deviceTier: SceneTier): SceneQuality {
  const quality = qualityFor(choice.tier === 'auto' ? deviceTier : choice.tier)
  if (choice.shadows) quality.shadows = choice.shadows
  if (choice.frameCap !== undefined) {
    quality.frameCap = choice.frameCap === 'display' ? Infinity : choice.frameCap
  }
  return quality
}

/**
 * The choice stored as `raw`: its JSON, or a bare tier name as the choice was once stored. Any
 * part that is not a known value is left out, and anything unreadable is the default.
 */
export function parseQualityChoice(raw: string | null): QualityChoice {
  if (isSceneTier(raw)) return { tier: raw }
  let stored: unknown
  try {
    stored = raw === null ? undefined : JSON.parse(raw)
  } catch {
    return { ...DEFAULT_QUALITY_CHOICE }
  }
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_QUALITY_CHOICE }
  const { tier, shadows, frameCap } = stored as Record<string, unknown>
  return {
    tier: isSceneTier(tier) ? tier : 'auto',
    ...((SHADOW_SETTINGS as readonly unknown[]).includes(shadows) && {
      shadows: shadows as SceneQuality['shadows'],
    }),
    ...((FRAME_CAP_SETTINGS as readonly unknown[]).includes(frameCap) && {
      frameCap: frameCap as FrameCapSetting,
    }),
  }
}

/** `choice` as stored; null for the default, which nothing needs to store. */
export function serializeQualityChoice(choice: QualityChoice): string | null {
  const { tier, shadows, frameCap } = choice
  if (tier === 'auto' && shadows === undefined && frameCap === undefined) return null
  return JSON.stringify({ tier, shadows, frameCap })
}

/** What the browser tells of the device; a browser that does not report a figure leaves it out. */
export interface SceneDevice {
  /** `navigator.hardwareConcurrency`. */
  cores?: number
  /** `navigator.deviceMemory`, gigabytes; Chromium only, and capped at 8. */
  memoryGb?: number
  /** Whether the primary pointer is coarse: a finger, not a mouse or a touchpad. */
  touch: boolean
  /** The screen's shorter side, CSS pixels. */
  screenShortPx: number
}

/**
 * The tier a viewer starts with, before choosing one. The figures only hint at the GPU, which the
 * browser does not name reliably, so the guess is cautious only where the hint is strong.
 */
export function defaultTier(device: SceneDevice): SceneTier {
  // Unreported figures count as enough: Firefox and Safari report no memory, and a desktop
  // should not drop to a lower tier for that.
  const cores = device.cores ?? 8
  const memoryGb = device.memoryGb ?? 8
  // Two cores or 2 GB is an entry phone or an old Chromebook: its GPU shares that memory.
  if (cores <= 2 || memoryGb <= 2) return 'low'
  if (device.touch) {
    // A phone (shorter side under 600 CSS px, the usual phone/tablet breakpoint) packs two to
    // three device pixels per CSS pixel on a GPU that throttles with heat; only a recent one,
    // six cores and 4 GB or more, gets medium.
    if (device.screenShortPx < 600) return cores >= 6 && memoryGb >= 4 ? 'medium' : 'low'
    return 'medium'
  }
  // Eight threads and 8 GB is the floor of a current desktop or gaming laptop, whose GPU draws
  // the high tier at a few per cent of its time; fewer is an older or thin laptop on an
  // integrated GPU.
  return cores >= 8 && memoryGb >= 8 ? 'high' : 'medium'
}
