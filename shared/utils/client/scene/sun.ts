import { ClientError } from '../errors'
import type { Rgb } from './palette'
import { rgbHex } from './palette'

/*
 * The Martian sun and sky over a stop: where the sun stands at a moment of the sol, and the
 * light, sky colours and camera exposure that go with its elevation. World x east, y north, z up.
 */

/** Mars' axial tilt (obliquity), degrees. */
export const MARS_OBLIQUITY_DEG = 25.19
/**
 * Areocentric solar longitude of the scene's season, degrees. 0 is the northern spring
 * equinox: the sun rises due east at a quarter of the sol and sets due west at three quarters,
 * everywhere. The mission has no calendar, so the season is fixed; a calendar would make it vary.
 */
export const SCENE_LS_DEG = 0
/** Latitude of the scene, degrees north: Jezero crater. */
export const DEFAULT_LATITUDE_DEG = 18.4

const RAD = Math.PI / 180

export interface SunPosition {
  /** Unit vector from the ground towards the sun. */
  direction: { x: number; y: number; z: number }
  /** Degrees above the horizon; negative below it. */
  elevationDeg: number
  /** Degrees clockwise from north: 90 east, 180 south, 270 west; in [0, 360). */
  azimuthDeg: number
}

/**
 * The sun at `solFraction` of the sol (0 and 1 midnight, 0.5 local noon) seen from
 * `latitudeDeg`, in the season {@link SCENE_LS_DEG}. The fraction is read as local solar time:
 * the mission's clock is mean solar time and the world has no longitude, so the equation of time
 * (up to about 50 minutes on Mars) is left out.
 */
export function sunPosition(
  solFraction: number,
  latitudeDeg: number = DEFAULT_LATITUDE_DEG,
): SunPosition {
  if (!Number.isFinite(solFraction) || !Number.isFinite(latitudeDeg)) {
    throw new ClientError(
      'INVALID_INPUT',
      `sunPosition: sol fraction ${solFraction} at latitude ${latitudeDeg}; pass finite numbers.`,
    )
  }
  const declination = Math.asin(Math.sin(MARS_OBLIQUITY_DEG * RAD) * Math.sin(SCENE_LS_DEG * RAD))
  const hourAngle = (solFraction - 0.5) * 2 * Math.PI
  const lat = latitudeDeg * RAD
  const cosD = Math.cos(declination)
  const sinD = Math.sin(declination)
  const direction = {
    // Afternoon (positive hour angle) puts the sun in the west.
    x: -cosD * Math.sin(hourAngle),
    y: Math.cos(lat) * sinD - Math.sin(lat) * cosD * Math.cos(hourAngle),
    z: Math.sin(lat) * sinD + Math.cos(lat) * cosD * Math.cos(hourAngle),
  }
  const azimuth = Math.atan2(direction.x, direction.y) / RAD
  return {
    direction,
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, direction.z))) / RAD,
    azimuthDeg: (azimuth + 360) % 360,
  }
}

export interface SkyLighting {
  /** Direct sunlight: colour and irradiance, 1 for the sun high in a clear sky. */
  sun: { color: string; intensity: number }
  /** Diffuse skylight from above, on the same scale. */
  sky: { color: string; intensity: number }
  /** Light bounced up from the ground, at the sky's intensity. */
  ground: string
  /** Sky colour at the horizon and at the zenith, and of the glow around the sun, as seen. */
  horizon: string
  zenith: string
  glow: string
  /** Camera exposure the eye would settle on under this light: 1 at noon, more as light fades. */
  exposure: number
  /** Shadow edge blur, in shadow-map texels: dust scatters a low sun's light over a wider disc. */
  shadowRadius: number
}

interface Key {
  elevationDeg: number
  sun: Rgb
  sunIntensity: number
  sky: Rgb
  skyIntensity: number
  ground: Rgb
  horizon: Rgb
  zenith: Rgb
  glow: Rgb
  exposure: number
  shadowRadius: number
}

/**
 * The sky by sun elevation, interpolated between keys. Mars gets about 43 % of Earth's
 * sunlight, and its dusty air scatters much of it: by day the sky is butterscotch and a large
 * share of the light is diffuse, so shadows are soft and never black; near the horizon the sun
 * dims and reddens through the long dusty path while forward scattering turns the sky around it
 * blue and the rest a darker pinkish brown; by night the sky is near black with a faint band
 * along the horizon. Exposure rises as the light fades, but less than the light does, so dusk
 * looks dim and night dark.
 */
const KEYS: readonly Key[] = [
  {
    elevationDeg: -18,
    sun: [255, 170, 110],
    sunIntensity: 0,
    sky: [60, 64, 90],
    skyIntensity: 0.012,
    ground: [30, 26, 24],
    horizon: [24, 22, 28],
    zenith: [7, 7, 11],
    glow: [24, 22, 28],
    exposure: 3.2,
    shadowRadius: 8,
  },
  {
    elevationDeg: -9,
    sun: [255, 170, 110],
    sunIntensity: 0,
    sky: [70, 80, 120],
    skyIntensity: 0.025,
    ground: [40, 34, 30],
    horizon: [48, 42, 50],
    zenith: [14, 14, 22],
    glow: [52, 70, 110],
    exposure: 3.0,
    shadowRadius: 8,
  },
  {
    elevationDeg: -3,
    sun: [255, 170, 110],
    sunIntensity: 0,
    sky: [110, 112, 140],
    skyIntensity: 0.07,
    ground: [70, 56, 48],
    horizon: [104, 82, 84],
    zenith: [40, 34, 42],
    glow: [96, 132, 184],
    exposure: 2.4,
    shadowRadius: 8,
  },
  {
    elevationDeg: 0,
    sun: [255, 176, 118],
    sunIntensity: 0.04,
    sky: [150, 138, 150],
    skyIntensity: 0.12,
    ground: [96, 76, 62],
    horizon: [136, 104, 98],
    zenith: [70, 56, 58],
    glow: [132, 170, 214],
    exposure: 2.0,
    shadowRadius: 7,
  },
  {
    elevationDeg: 4,
    sun: [255, 196, 146],
    sunIntensity: 0.2,
    sky: [184, 160, 148],
    skyIntensity: 0.2,
    ground: [112, 90, 70],
    horizon: [170, 132, 110],
    zenith: [112, 88, 76],
    glow: [168, 190, 214],
    exposure: 1.6,
    shadowRadius: 5,
  },
  {
    elevationDeg: 12,
    sun: [255, 222, 186],
    sunIntensity: 0.55,
    sky: [205, 172, 136],
    skyIntensity: 0.3,
    ground: [118, 96, 74],
    horizon: [204, 168, 130],
    zenith: [170, 134, 102],
    glow: [222, 212, 200],
    exposure: 1.2,
    shadowRadius: 3.5,
  },
  {
    elevationDeg: 30,
    sun: [255, 238, 216],
    sunIntensity: 0.85,
    sky: [210, 172, 130],
    skyIntensity: 0.36,
    ground: [122, 100, 76],
    horizon: [212, 176, 136],
    zenith: [192, 152, 114],
    glow: [236, 224, 206],
    exposure: 1.05,
    shadowRadius: 2.5,
  },
  {
    elevationDeg: 90,
    sun: [255, 244, 230],
    sunIntensity: 1,
    sky: [212, 174, 130],
    skyIntensity: 0.38,
    ground: [124, 102, 78],
    horizon: [214, 180, 140],
    zenith: [200, 162, 122],
    glow: [240, 230, 214],
    exposure: 1,
    shadowRadius: 2,
  },
]

const mix = (a: number, b: number, f: number) => a + (b - a) * f
const mixRgb = (a: Readonly<Rgb>, b: Readonly<Rgb>, f: number): Rgb => [
  mix(a[0], b[0], f),
  mix(a[1], b[1], f),
  mix(a[2], b[2], f),
]

/** The light, sky and exposure for a sun `elevationDeg` above the horizon (negative below it). */
export function skyLighting(elevationDeg: number): SkyLighting {
  if (!Number.isFinite(elevationDeg)) {
    throw new ClientError(
      'INVALID_INPUT',
      `skyLighting: elevation ${elevationDeg}; pass a finite number of degrees.`,
    )
  }
  const last = KEYS.length - 1
  let k = 0
  while (k < last - 1 && KEYS[k + 1]!.elevationDeg <= elevationDeg) k++
  const a = KEYS[k]!
  const b = KEYS[k + 1]!
  const f = Math.min(
    1,
    Math.max(0, (elevationDeg - a.elevationDeg) / (b.elevationDeg - a.elevationDeg)),
  )
  const hex = (key: 'sun' | 'sky' | 'ground' | 'horizon' | 'zenith' | 'glow') =>
    rgbHex(mixRgb(a[key], b[key], f))
  return {
    sun: { color: hex('sun'), intensity: mix(a.sunIntensity, b.sunIntensity, f) },
    sky: { color: hex('sky'), intensity: mix(a.skyIntensity, b.skyIntensity, f) },
    ground: hex('ground'),
    horizon: hex('horizon'),
    zenith: hex('zenith'),
    glow: hex('glow'),
    exposure: mix(a.exposure, b.exposure, f),
    shadowRadius: mix(a.shadowRadius, b.shadowRadius, f),
  }
}

/** Share of the colour-mode fog fill in the scene's atmosphere under a high sun. */
const FILL_SHARE = 0.3
/** Skylight at which the fill takes its full share: the high sun's. */
const FULL_DAY_SKY = KEYS.at(-1)!.skyIntensity

/**
 * The colour of the scene's haze, sky at the horizon and unseen ground: the sky's horizon with
 * the colour mode's fog `fill` blended in by daylight, so unseen ground reads as the same fog on
 * the map and in the scene by day and the scene still darkens at night.
 */
export function atmosphereColor(lighting: SkyLighting, fill: Readonly<Rgb>): string {
  const share = FILL_SHARE * Math.min(1, lighting.sky.intensity / FULL_DAY_SKY)
  return rgbHex(mixRgb(hexRgb(lighting.horizon), fill, share))
}

function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
