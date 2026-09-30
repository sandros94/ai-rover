import type {
  QualityChoice,
  SceneDevice,
  SceneQuality,
  SceneTier,
} from '#shared/utils/client/scene'
import {
  DEFAULT_QUALITY_CHOICE,
  defaultTier,
  parseQualityChoice,
  resolveQuality,
  serializeQualityChoice,
} from '#shared/utils/client/scene'

/**
 * Browser storage key of the viewer's choice (see `parseQualityChoice`); absent while nothing is
 * chosen.
 */
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
 * The stop scene's quality for this viewer: the choice (a tier, `auto` for the device's default,
 * and any knob set over it) and the knobs it sets (`resolveQuality`). Set `choice` to change it;
 * the choice is kept in this browser. Storage that is blocked or absent only means the choice
 * lasts for the page. Every caller shares the same state, so a settings control and the scene
 * agree.
 */
export function useSceneQuality() {
  const stored = useState<QualityChoice>('scene-quality', () => ({ ...DEFAULT_QUALITY_CHOICE }))
  const read = useState('scene-quality-read', () => false)
  const device = useState<SceneTier | null>('scene-quality-device', () => null)

  function load(): void {
    if (read.value) return
    read.value = true
    device.value = defaultTier(readSceneDevice())
    try {
      stored.value = parseQualityChoice(localStorage.getItem(SCENE_QUALITY_KEY))
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

  const choice = computed<QualityChoice>({
    get: () => stored.value,
    set(next) {
      stored.value = next
      const raw = serializeQualityChoice(next)
      try {
        if (raw === null) localStorage.removeItem(SCENE_QUALITY_KEY)
        else localStorage.setItem(SCENE_QUALITY_KEY, raw)
      } catch {
        // Storage unavailable: the choice lasts for this page only.
      }
    },
  })
  /** The device's default, `medium` until the browser has been read. */
  const deviceTier = computed<SceneTier>(() => device.value ?? 'medium')
  const quality = computed<SceneQuality>(() => resolveQuality(stored.value, deviceTier.value))
  const tier = computed<SceneTier>(() => quality.value.tier)
  return { choice, tier, deviceTier, quality }
}
