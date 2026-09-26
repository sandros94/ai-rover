/**
 * The relief colours shared by the 2D map and the 3D scene: a Mars ochre height ramp, a
 * hillshade light and the fog applied to ground the rover has not seen. Channels are sRGB 0–255
 * unless a name says linear.
 */

/** Hillshade light: from the north-west (azimuth 315°), 45° above the horizon; world x east, y north, z up. */
const LIGHT_ALTITUDE = Math.PI / 4
export const HILLSHADE_LIGHT = Object.freeze({
  x: -Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  y: Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  z: Math.sin(LIGHT_ALTITUDE),
})

/** Luma weights (Rec. 709) applied to the 8-bit channels, for greying fogged ground. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const

/** Brightness kept on ground the rover has not seen: its luma times this. */
export const FOG_DIM = 0.45
/** Share of an unseen vertex's colour replaced by its own grey, 0 (none) to 1 (all). */
export const FOG_DESATURATE = 0.8

export type Rgb = [number, number, number]

/** The ramp colour at `t`, 0 the lowest ground of the range and 1 the highest; clamped. */
export function reliefRgb(t: number): Rgb {
  const u = Math.min(1, Math.max(0, t))
  return [90 + 150 * u, 45 + 125 * u, 30 + 95 * u]
}

/** Lambert shade in [0, 1] of a surface with gradient (`gx`, `gy`) under {@link HILLSHADE_LIGHT}. */
export function hillshadeAt(gx: number, gy: number): number {
  const L = HILLSHADE_LIGHT
  return Math.max(0, (-gx * L.x - gy * L.y + L.z) / Math.sqrt(gx * gx + gy * gy + 1))
}

/** Factor applied to the ramp colour for a hillshade value: a floor in full shade, above 1 in full light. */
export function reliefLight(shade: number): number {
  return 0.25 + 0.95 * shade
}

/** The colour as shown on unseen ground: dimmed by {@link FOG_DIM}, greyed by {@link FOG_DESATURATE}. */
export function fogRgb([r, g, b]: Rgb): Rgb {
  const grey = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  return [
    FOG_DIM * (r + FOG_DESATURATE * (grey - r)),
    FOG_DIM * (g + FOG_DESATURATE * (grey - g)),
    FOG_DIM * (b + FOG_DESATURATE * (grey - b)),
  ]
}

/** One sRGB channel, 0–255 and clamped, as a linear value in [0, 1]: what three.js vertex colours hold. */
export function srgbToLinear(channel: number): number {
  const c = Math.min(255, Math.max(0, channel)) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Overlay colours of the 3D scene, the hex values of the Nuxt UI tokens the 2D map draws the
 * same things with (WebGL cannot read CSS variables): route `--ui-info`, driven path
 * `--ui-primary`, past stops `--ui-text-toned`, deaths `--ui-error`.
 */
export const SCENE_COLORS = Object.freeze({
  route: '#38bdf8',
  driven: '#fb923c',
  stop: '#d6d3d1',
  death: '#ef4444',
  sky: '#1c1714',
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
