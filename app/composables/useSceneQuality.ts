import type { SceneDevice, SceneQuality, SceneTier } from '#shared/utils/client/scene'
import { defaultTier, isSceneTier, qualityFor } from '#shared/utils/client/scene'

/** Browser storage key of the viewer's chosen tier; absent while the device's default applies. */
export const SCENE_QUALITY_KEY = 'ai-rover:scene-quality'

/** What this browser reports of its device, for {@link defaultTier}. */
export function readSceneDevice(): SceneDevice {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    cores: nav.hardwareConcurrency || undefined,
    memoryGb: nav.deviceMemory,
    touch: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    screenShortPx: Math.min(screen.width, screen.height),
  }
}

/**
 * The stop scene's quality for this viewer: the tier chosen (`auto` for the device's default) and
 * the knobs it sets. Set `choice` to change it; the choice is kept in this browser. Storage
 * that is blocked or absent only means the choice lasts for the page. Every caller shares the
 * same state, so a settings control and the scene agree.
 */
export function useSceneQuality() {
  const stored = useState<SceneTier | null>('scene-quality', () => null)
  const read = useState('scene-quality-read', () => false)
  const device = useState<SceneTier | null>('scene-quality-device', () => null)

  function load(): void {
    if (read.value) return
    read.value = true
    device.value = defaultTier(readSceneDevice())
    try {
      const value = localStorage.getItem(SCENE_QUALITY_KEY)
      if (isSceneTier(value)) stored.value = value
    } catch {
      // Storage unavailable: the device's default applies.
    }
  }
  // Read after hydration, so a server-rendered control and the first client render agree; the
  // scene itself only mounts in the browser and reads at once.
  if (import.meta.client) {
    if (useNuxtApp().isHydrating) onMounted(load)
    else load()
  }

  const choice = computed<SceneTier | 'auto'>({
    get: () => stored.value ?? 'auto',
    set(next) {
      stored.value = next === 'auto' ? null : next
      try {
        if (next === 'auto') localStorage.removeItem(SCENE_QUALITY_KEY)
        else localStorage.setItem(SCENE_QUALITY_KEY, next)
      } catch {
        // Storage unavailable: the choice lasts for this page only.
      }
    },
  })
  /** The device's default, `medium` until the browser has been read. */
  const deviceTier = computed<SceneTier>(() => device.value ?? 'medium')
  const tier = computed<SceneTier>(() => stored.value ?? deviceTier.value)
  const quality = computed<SceneQuality>(() => qualityFor(tier.value))
  return { choice, tier, deviceTier, quality }
}
