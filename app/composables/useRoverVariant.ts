/**
 * Which rover the scene draws: the procedural one (instant, no download), or the JPL model at
 * hero or phone detail.
 */
export type RoverVariant = 'procedural' | 'hero' | 'low'

let chosen: Exclude<RoverVariant, 'procedural'> | undefined

/**
 * The JPL model detail for this device, decided once per page load: machines with four cores or
 * fewer and touch-first devices get the light model.
 */
export function useRoverVariant(): Exclude<RoverVariant, 'procedural'> {
  if (chosen) return chosen
  // The server cannot see the device; the scene renders on the client only.
  if (import.meta.server) return 'hero'
  const cores = navigator.hardwareConcurrency ?? Infinity
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  chosen = cores <= 4 || coarse ? 'low' : 'hero'
  return chosen
}
