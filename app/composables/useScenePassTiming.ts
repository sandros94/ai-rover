import type { ScenePassTiming } from '~/utils/scene-pass-timer'

/** The stop scene's per-pass timing, filled in development only; see `timeScenePasses`. */
export function useScenePassTiming() {
  return useState<ScenePassTiming | null>('scene-pass-timing', () => null)
}
