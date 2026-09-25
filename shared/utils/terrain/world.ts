import type { NoiseFunction2D } from 'simplex-noise'
import { createNoise2D } from 'simplex-noise'
import { TerrainError } from './errors'
import { deriveSeed, hashString, mulberry32 } from './seed'

/** Base relief: fBm of 2D simplex noise. Lengths in metres. */
export interface ReliefConfig {
  /** Number of noise octaves summed. */
  octaves: number
  /** Wavelength of the lowest octave. */
  wavelength: number
  /** Peak height of the summed noise; the fBm is normalised to [-amplitude, amplitude]. */
  amplitude: number
  /** Frequency multiplier from one octave to the next. */
  lacunarity: number
  /** Amplitude multiplier from one octave to the next. */
  gain: number
}

/**
 * Crater population. Each crater cell hashes to its own craters; radii follow a truncated power
 * law with cumulative exponent −2 (N(>r) ∝ r⁻²), fixed so the draw needs only `Math.sqrt`.
 */
export interface CraterConfig {
  /** Side of the square cell that owns a batch of craters. */
  cellSize: number
  /** Mean number of craters per cell; counts are uniform in [0, 2·mean]. */
  meanPerCell: number
  minRadius: number
  /** `maxRadius · ejectaExtent` must not exceed `cellSize`: craters only reach neighbouring cells. */
  maxRadius: number
  /** Bowl depth over crater diameter. */
  depthRatio: number
  /** Rim height over crater diameter. */
  rimRatio: number
  /** Half-width of the rim bump, in crater radii. */
  rimWidth: number
  /** Distance, in crater radii, at which the ejecta blanket reaches zero. Greater than 1. */
  ejectaExtent: number
  /** Lower bound of the per-crater freshness factor scaling depth and rim, in (0, 1]. */
  minFreshness: number
}

export interface WorldConfig {
  /** Mission seed; any non-empty string. */
  seed: string
  /** Chunk side in metres; a positive multiple of `cellSize`. Default 64. */
  chunkSize?: number
  /** Grid spacing in metres. Default 1. */
  cellSize?: number
  /** Viewer height above ground for line of sight, metres. Default 2. */
  mastHeight?: number
  /** Steepest traversable slope, degrees in (0, 90). Default 16. */
  slopeLimitDeg?: number
  relief?: Partial<ReliefConfig>
  craters?: Partial<CraterConfig>
}

export interface ResolvedWorldConfig {
  readonly seed: string
  readonly chunkSize: number
  readonly cellSize: number
  readonly mastHeight: number
  readonly slopeLimitDeg: number
  readonly relief: Readonly<ReliefConfig>
  readonly craters: Readonly<CraterConfig>
}

export interface World {
  readonly config: ResolvedWorldConfig
  /** Terrain height in metres at world position (x, y), x east, y north. */
  readonly heightAt: (x: number, y: number) => number
}

export const DEFAULT_RELIEF: Readonly<ReliefConfig> = Object.freeze({
  octaves: 6,
  wavelength: 1024,
  amplitude: 16,
  lacunarity: 2,
  gain: 0.5,
})

export const DEFAULT_CRATERS: Readonly<CraterConfig> = Object.freeze({
  cellSize: 256,
  meanPerCell: 16,
  minRadius: 2,
  maxRadius: 60,
  depthRatio: 0.2,
  rimRatio: 0.04,
  rimWidth: 0.3,
  ejectaExtent: 3,
  minFreshness: 0.3,
})

interface Crater {
  x: number
  y: number
  radius: number
  depth: number
  rim: number
  /** Global age rank key: lower applies first, so later craters overprint earlier ones. */
  age: number
  cellX: number
  cellY: number
  index: number
}

interface WorldInternals {
  config: ResolvedWorldConfig
  octaves: NoiseFunction2D[]
  rootSeed: number
  reachCache: Map<string, Crater[]>
}

const internals = new WeakMap<World, WorldInternals>()

/** Crater-cell reach lists kept per world; oldest entries are evicted first. */
const REACH_CACHE_LIMIT = 64

const LANE_OCTAVE = 1
const LANE_CRATER = 2

export function defineWorld(config: WorldConfig): World {
  const resolved = resolveConfig(config)
  const rootSeed = hashString(resolved.seed)
  const octaves: NoiseFunction2D[] = []
  for (let k = 0; k < resolved.relief.octaves; k++) {
    octaves.push(createNoise2D(mulberry32(deriveSeed(rootSeed, LANE_OCTAVE, k))))
  }
  const state: WorldInternals = { config: resolved, octaves, rootSeed, reachCache: new Map() }
  const world: World = Object.freeze({
    config: resolved,
    heightAt: (x: number, y: number): number => {
      let h = reliefAt(state, x, y)
      h += cratersAtPoint(state, x, y)
      return h
    },
  })
  internals.set(world, state)
  return world
}

/**
 * Samples a vertex grid of heights: vertex (i, j) lies at world
 * `((originI + i) · cellSize, (originJ + j) · cellSize)`, row-major with `j` rows.
 * Each value equals `Math.fround(world.heightAt(x, y))` for that vertex.
 */
export function sampleHeights(
  world: World,
  options: { originI: number; originJ: number; width: number; height: number },
): Float32Array {
  const state = internals.get(world)
  if (!state) {
    throw new TerrainError(
      'INVALID_CONFIG',
      'sampleHeights received a world not created by defineWorld; build it with defineWorld(config).',
    )
  }
  const { originI, originJ, width, height } = options
  for (const [name, value] of [
    ['originI', originI],
    ['originJ', originJ],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new TerrainError(
        'OUT_OF_BOUNDS',
        `sampleHeights ${name} is ${value}; pass a safe integer grid index.`,
      )
    }
  }
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new TerrainError(
      'INVALID_GRID',
      `sampleHeights size is ${width}×${height}; pass positive integer width and height.`,
    )
  }
  const { cellSize } = state.config
  const values = new Float64Array(width * height)
  for (let j = 0; j < height; j++) {
    const y = (originJ + j) * cellSize
    for (let i = 0; i < width; i++)
      values[j * width + i] = reliefAt(state, (originI + i) * cellSize, y)
  }
  const craters = new Float64Array(width * height)
  const xMin = originI * cellSize
  const yMin = originJ * cellSize
  const xMax = (originI + width - 1) * cellSize
  const yMax = (originJ + height - 1) * cellSize
  const { ejectaExtent } = state.config.craters
  for (const crater of cratersForRegion(state, xMin, yMin, xMax, yMax)) {
    const reach = crater.radius * ejectaExtent
    const i0 = Math.max(0, Math.floor((crater.x - reach) / cellSize) - originI)
    const i1 = Math.min(width - 1, Math.ceil((crater.x + reach) / cellSize) - originI)
    const j0 = Math.max(0, Math.floor((crater.y - reach) / cellSize) - originJ)
    const j1 = Math.min(height - 1, Math.ceil((crater.y + reach) / cellSize) - originJ)
    for (let j = j0; j <= j1; j++) {
      const y = (originJ + j) * cellSize
      for (let i = i0; i <= i1; i++) {
        const k = j * width + i
        craters[k] = stampCrater(state, crater, (originI + i) * cellSize, y, craters[k]!)
      }
    }
  }
  const out = new Float32Array(width * height)
  for (let k = 0; k < out.length; k++) out[k] = values[k]! + craters[k]!
  return out
}

function reliefAt(state: WorldInternals, x: number, y: number): number {
  const { wavelength, amplitude, lacunarity, gain } = state.config.relief
  let frequency = 1 / wavelength
  let weight = 1
  let sum = 0
  let total = 0
  for (const noise of state.octaves) {
    sum += weight * noise(x * frequency, y * frequency)
    total += weight
    frequency *= lacunarity
    weight *= gain
  }
  return total === 0 ? 0 : (amplitude * sum) / total
}

function cratersAtPoint(state: WorldInternals, x: number, y: number): number {
  const size = state.config.craters.cellSize
  let h = 0
  for (const crater of reachList(state, Math.floor(x / size), Math.floor(y / size))) {
    h = stampCrater(state, crater, x, y, h)
  }
  return h
}

/**
 * Applies one crater over the accumulated crater relief `below`. Only `+ − × ÷` and `sqrt` are
 * used so heights are bit-identical on every IEEE-754 host; a point out of reach returns `below`
 * unchanged, which keeps chunk and point evaluation exact whatever crater set each one scans.
 */
function stampCrater(
  state: WorldInternals,
  crater: Crater,
  x: number,
  y: number,
  below: number,
): number {
  const { rimWidth, ejectaExtent } = state.config.craters
  const dx = x - crater.x
  const dy = y - crater.y
  const d2 = dx * dx + dy * dy
  const reach = crater.radius * ejectaExtent
  if (d2 >= reach * reach) return below
  const d = Math.sqrt(d2) / crater.radius
  const t = (d - 1) / rimWidth
  const rimBump = t > -1 && t < 1 ? (1 - t * t) * (1 - t * t) : 0
  if (d < 1) {
    const d4 = d * d * d * d
    const profile = -crater.depth * (1 - d * d) + crater.rim * rimBump
    return below * d4 + profile
  }
  const inv = 1 / (ejectaExtent * ejectaExtent * ejectaExtent)
  const ejecta = (1 / (d * d * d) - inv) / (1 - inv)
  return below + crater.rim * (rimBump > ejecta ? rimBump : ejecta)
}

/** Craters that can reach any point of crater cell (cellX, cellY), oldest first. */
function reachList(state: WorldInternals, cellX: number, cellY: number): Crater[] {
  const key = `${cellX},${cellY}`
  const cached = state.reachCache.get(key)
  if (cached) return cached
  const list: Crater[] = []
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) list.push(...cellCraters(state, cellX + ox, cellY + oy))
  list.sort(compareAge)
  if (state.reachCache.size >= REACH_CACHE_LIMIT) {
    const oldest = state.reachCache.keys().next()
    if (!oldest.done) state.reachCache.delete(oldest.value)
  }
  state.reachCache.set(key, list)
  return list
}

function cratersForRegion(
  state: WorldInternals,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
): Crater[] {
  const size = state.config.craters.cellSize
  const list: Crater[] = []
  const cx0 = Math.floor(xMin / size) - 1
  const cx1 = Math.floor(xMax / size) + 1
  const cy0 = Math.floor(yMin / size) - 1
  const cy1 = Math.floor(yMax / size) + 1
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) list.push(...cellCraters(state, cx, cy))
  return list.sort(compareAge)
}

function compareAge(a: Crater, b: Crater): number {
  return a.age - b.age || a.cellX - b.cellX || a.cellY - b.cellY || a.index - b.index
}

function cellCraters(state: WorldInternals, cellX: number, cellY: number): Crater[] {
  const { cellSize, meanPerCell, minRadius, maxRadius, depthRatio, rimRatio, minFreshness } =
    state.config.craters
  const random = mulberry32(deriveSeed(state.rootSeed, LANE_CRATER, cellX, cellY))
  const count = Math.floor(random() * (2 * meanPerCell + 1))
  const invMin2 = 1 / (minRadius * minRadius)
  const invMax2 = 1 / (maxRadius * maxRadius)
  const craters: Crater[] = []
  for (let index = 0; index < count; index++) {
    const x = (cellX + random()) * cellSize
    const y = (cellY + random()) * cellSize
    const radius = 1 / Math.sqrt(invMin2 - random() * (invMin2 - invMax2))
    const freshness = minFreshness + (1 - minFreshness) * random()
    const age = random() * 4294967296
    craters.push({
      x,
      y,
      radius,
      depth: depthRatio * 2 * radius * freshness,
      rim: rimRatio * 2 * radius * freshness,
      age,
      cellX,
      cellY,
      index,
    })
  }
  return craters
}

function resolveConfig(config: WorldConfig): ResolvedWorldConfig {
  if (typeof config.seed !== 'string' || config.seed.length === 0) {
    throw new TerrainError(
      'INVALID_CONFIG',
      'World seed is empty; pass a non-empty string as config.seed.',
    )
  }
  const relief: ReliefConfig = { ...DEFAULT_RELIEF, ...config.relief }
  const craters: CraterConfig = { ...DEFAULT_CRATERS, ...config.craters }
  const resolved: ResolvedWorldConfig = {
    seed: config.seed,
    chunkSize: config.chunkSize ?? 64,
    cellSize: config.cellSize ?? 1,
    mastHeight: config.mastHeight ?? 2,
    slopeLimitDeg: config.slopeLimitDeg ?? 16,
    relief: Object.freeze(relief),
    craters: Object.freeze(craters),
  }

  const check = (ok: boolean, field: string, value: number, expected: string): void => {
    if (!ok)
      throw new TerrainError(
        'INVALID_CONFIG',
        `World config ${field} is ${value}; expected ${expected}.`,
      )
  }
  const positive = (field: string, value: number): void =>
    check(Number.isFinite(value) && value > 0, field, value, 'a finite number greater than 0')
  const nonNegative = (field: string, value: number): void =>
    check(Number.isFinite(value) && value >= 0, field, value, 'a finite number of at least 0')

  positive('cellSize', resolved.cellSize)
  positive('chunkSize', resolved.chunkSize)
  const cells = resolved.chunkSize / resolved.cellSize
  check(
    Number.isInteger(cells) && cells + 1 <= 0xffff,
    'chunkSize',
    resolved.chunkSize,
    `a multiple of cellSize (${resolved.cellSize}) spanning at most 65534 cells`,
  )
  nonNegative('mastHeight', resolved.mastHeight)
  check(
    Number.isFinite(resolved.slopeLimitDeg) &&
      resolved.slopeLimitDeg > 0 &&
      resolved.slopeLimitDeg < 90,
    'slopeLimitDeg',
    resolved.slopeLimitDeg,
    'degrees strictly between 0 and 90',
  )

  check(
    Number.isInteger(relief.octaves) && relief.octaves >= 0 && relief.octaves <= 16,
    'relief.octaves',
    relief.octaves,
    'an integer from 0 to 16',
  )
  positive('relief.wavelength', relief.wavelength)
  nonNegative('relief.amplitude', relief.amplitude)
  positive('relief.lacunarity', relief.lacunarity)
  positive('relief.gain', relief.gain)

  positive('craters.cellSize', craters.cellSize)
  nonNegative('craters.meanPerCell', craters.meanPerCell)
  positive('craters.minRadius', craters.minRadius)
  check(
    Number.isFinite(craters.maxRadius) && craters.maxRadius >= craters.minRadius,
    'craters.maxRadius',
    craters.maxRadius,
    `a finite number of at least craters.minRadius (${craters.minRadius})`,
  )
  nonNegative('craters.depthRatio', craters.depthRatio)
  nonNegative('craters.rimRatio', craters.rimRatio)
  positive('craters.rimWidth', craters.rimWidth)
  check(
    Number.isFinite(craters.ejectaExtent) && craters.ejectaExtent > 1,
    'craters.ejectaExtent',
    craters.ejectaExtent,
    'a finite number greater than 1',
  )
  check(
    craters.maxRadius * craters.ejectaExtent <= craters.cellSize,
    'craters.maxRadius',
    craters.maxRadius,
    `at most craters.cellSize / craters.ejectaExtent (${craters.cellSize / craters.ejectaExtent}) so craters reach only neighbouring cells`,
  )
  check(
    Number.isFinite(craters.minFreshness) && craters.minFreshness > 0 && craters.minFreshness <= 1,
    'craters.minFreshness',
    craters.minFreshness,
    'a number in (0, 1]',
  )

  return Object.freeze(resolved)
}
