/**
 * xmur3 string hash (bryc, public domain): folds a string into a 32-bit seed.
 */
export function hashString(value: string): number {
  let h = 1779033703 ^ value.length
  for (let k = 0; k < value.length; k++) {
    h = Math.imul(h ^ value.charCodeAt(k), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Mixes a seed with integer lanes into an independent 32-bit seed (murmur3 fmix32 finaliser per
 * lane). Lanes are truncated to int32, so callers pass integers only.
 */
export function deriveSeed(seed: number, ...lanes: number[]): number {
  let h = seed >>> 0
  for (const lane of lanes) {
    h = Math.imul(h ^ (lane | 0), 0x9e3779b1) + 0x7f4a7c15
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}

/**
 * mulberry32 PRNG (Tommy Ettinger, public domain): uniform floats in [0, 1) from a 32-bit seed,
 * built only from integer operations so every host produces the same sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
