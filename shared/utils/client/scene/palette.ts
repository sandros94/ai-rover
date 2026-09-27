/**
 * The relief colours shared by the 2D map and the 3D scene: a hypsometric height tint, a
 * hillshade light and the fill of ground the rover has not seen. Channels are sRGB 0–255 unless
 * a name says linear.
 */

/** Hillshade light: from the north-west (azimuth 315°), 45° above the horizon; world x east, y north, z up. */
const LIGHT_ALTITUDE = Math.PI / 4
export const HILLSHADE_LIGHT = Object.freeze({
  x: -Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  y: Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  z: Math.sin(LIGHT_ALTITUDE),
})

/**
 * Factor on slopes before shading: Martian ground within a stop is mostly gentle, and at its
 * true steepness a 5° rise barely changes the light.
 */
export const HILLSHADE_EXAGGERATION = 2.5

/** Luma weights (Rec. 709) applied to the 8-bit channels. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const

export type Rgb = [number, number, number]

/**
 * Tint stops from the lowest ground to the highest: dark umber, rust, ochre, sand, pale dust.
 * Lightness rises at every stop and every channel with it, so the ramp reads in order without a
 * legend and in greyscale.
 */
export const RELIEF_STOPS: readonly Readonly<Rgb>[] = Object.freeze([
  [74, 38, 28],
  [128, 62, 38],
  [178, 104, 56],
  [212, 152, 96],
  [236, 206, 160],
])

/** The tint at `t`, 0 the lowest ground of the range and 1 the highest; clamped. */
export function reliefRgb(t: number): Rgb {
  const last = RELIEF_STOPS.length - 1
  const u = Math.min(1, Math.max(0, t)) * last
  const k = Math.min(last - 1, Math.floor(u))
  const f = u - k
  const a = RELIEF_STOPS[k]!
  const b = RELIEF_STOPS[k + 1]!
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/**
 * Lambert shade in [0, 1] of a surface with gradient (`gx`, `gy`) under {@link HILLSHADE_LIGHT},
 * the gradient first scaled by `exaggeration`.
 */
export function hillshadeAt(
  gx: number,
  gy: number,
  exaggeration: number = HILLSHADE_EXAGGERATION,
): number {
  const L = HILLSHADE_LIGHT
  const x = gx * exaggeration
  const y = gy * exaggeration
  return Math.max(0, (-x * L.x - y * L.y + L.z) / Math.sqrt(x * x + y * y + 1))
}

/** Factor applied to the tint for a hillshade value: a floor in full shade, above 1 in full light. */
export function reliefLight(shade: number): number {
  return 0.25 + 0.95 * shade
}

export type ColorMode = 'light' | 'dark'

/** What unseen ground is drawn as, per colour mode; the 3D scene's distance fog and sky match it. */
export const FOG_FILL: Readonly<Record<ColorMode, Readonly<Rgb>>> = Object.freeze({
  light: Object.freeze([214, 208, 200] as Rgb),
  dark: Object.freeze([43, 39, 37] as Rgb),
})

/** Relative brightness swing of the 2D fog texture around its fill. */
export const FOG_GRAIN = 0.06

/** `#rrggbb` of a colour, channels rounded and clamped. */
export function rgbHex(rgb: Readonly<Rgb>): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** One sRGB channel, 0–255 and clamped, as a linear value in [0, 1]: what three.js vertex colours hold. */
export function srgbToLinear(channel: number): number {
  const c = Math.min(255, Math.max(0, channel)) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Overlay colours of the 3D scene, the hex values of the Nuxt UI tokens the 2D map draws the
 * same things with (WebGL cannot read CSS variables): route `--ui-info`, driven path
 * `--ui-primary`, deaths `--ui-error`.
 */
export const SCENE_COLORS = Object.freeze({
  route: '#38bdf8',
  driven: '#fb923c',
  death: '#ef4444',
  /** Whatever is focused. */
  focus: '#f59e0b',
  /**
   * Stop posts and flags, lit in the scene: artificial against the warm ground, told apart from
   * the relief tint and the fog fill of either colour mode by hue as much as lightness. The accent
   * is `--ui-primary` in light mode, saturated enough to hold on the palest dust.
   */
  marker: Object.freeze({
    /** Every post and pole: a warm white. */
    post: '#fbf8f1',
    /** A stop's sphere and the band under it, which one instanced mesh draws in one colour. */
    sphere: Object.freeze({ current: '#f97316', past: '#a8b8cc' }),
    flag: Object.freeze({ destination: '#f97316', goal: '#a8b8cc' }),
    /** The disc where a post meets the ground, drawn faint. */
    contact: '#1c1917',
  }),
})

/** Rover part colours by tone (see `PartTone`): white body, grey links, aluminium wheels. */
export const ROVER_TONES = Object.freeze({
  body: '#e7e2d6',
  deck: '#b9b3a6',
  link: '#6f6c66',
  tyre: '#a3a3a0',
  spoke: '#2b2a28',
  mast: '#d4d0c6',
  rtg: '#4b4a47',
})
