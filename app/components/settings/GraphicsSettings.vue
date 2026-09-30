<script setup lang="ts">
import type { FrameCapSetting, SceneQuality, SceneTier } from '#shared/utils/client/scene'
import {
  FRAME_CAP_SETTINGS,
  qualityFor,
  SCENE_TIERS,
  SHADOW_SETTINGS,
} from '#shared/utils/client/scene'

/**
 * The scene's quality for this viewer: a tier, or the device's, what that tier sets, and the
 * shadows and frame cap set over it. Kept in this browser; the scene follows at once.
 */
const { choice, tier, deviceTier } = useSceneQuality()

const TIER_NAME: Record<SceneTier, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const SHADOW_NAME: Record<SceneQuality['shadows'], string> = {
  full: 'Full',
  rover: 'Rover only',
  off: 'Off',
}
const frameCapName = (cap: number | FrameCapSetting) =>
  cap === 'display' || cap === Infinity ? 'Display rate' : `${cap} fps`

/** What a select shows for "follow the tier". */
const TIER_DEFAULT = 'tier'

const tierItems = computed(() => [
  { label: `Auto (${TIER_NAME[deviceTier.value]} on this device)`, value: 'auto' },
  ...SCENE_TIERS.map((value) => ({ label: TIER_NAME[value], value })),
])
/** What the tier in force sets, before anything chosen over it. */
const tierQuality = computed(() => qualityFor(tier.value))
const shadowItems = computed(() => [
  { label: `As the tier (${SHADOW_NAME[tierQuality.value.shadows]})`, value: TIER_DEFAULT },
  ...SHADOW_SETTINGS.map((value) => ({ label: SHADOW_NAME[value], value })),
])
const frameCapItems = computed(() => [
  { label: `As the tier (${frameCapName(tierQuality.value.frameCap)})`, value: TIER_DEFAULT },
  ...FRAME_CAP_SETTINGS.map((value) => ({ label: frameCapName(value), value: String(value) })),
])

const tierModel = computed({
  get: () => choice.value.tier,
  set: (next: SceneTier | 'auto') => (choice.value = { ...choice.value, tier: next }),
})
const shadowModel = computed({
  get: () => choice.value.shadows ?? TIER_DEFAULT,
  set(next: string) {
    const { shadows: _, ...rest } = choice.value
    choice.value =
      next === TIER_DEFAULT ? rest : { ...rest, shadows: next as SceneQuality['shadows'] }
  },
})
const frameCapModel = computed({
  get: () => (choice.value.frameCap === undefined ? TIER_DEFAULT : String(choice.value.frameCap)),
  set(next: string) {
    const { frameCap: _, ...rest } = choice.value
    const cap = FRAME_CAP_SETTINGS.find((value) => String(value) === next)
    choice.value = cap === undefined ? rest : { ...rest, frameCap: cap }
  },
})

const tierSets = computed(() => {
  const q = tierQuality.value
  return [
    { term: 'Frame cap', value: frameCapName(q.frameCap) },
    { term: 'Pixel ratio cap', value: `${q.maxDpr}×` },
    { term: 'Shadows', value: `${SHADOW_NAME[q.shadows]}, ${q.shadowMapSize} px map` },
    {
      term: 'Low-poly rover beyond',
      value: q.roverLodM === null ? 'never' : `${q.roverLodM} m`,
    },
  ]
})
</script>

<template>
  <div data-test="graphics" class="space-y-4">
    <UFormField label="Quality" name="tier">
      <USelect
        v-model="tierModel"
        data-test="graphics-tier"
        :items="tierItems"
        class="w-full sm:w-72"
      />
    </UFormField>
    <dl data-test="graphics-tier-sets" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <template v-for="row in tierSets" :key="row.term">
        <dt class="text-muted">{{ row.term }}</dt>
        <dd>{{ row.value }}</dd>
      </template>
    </dl>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Shadows" name="shadows">
        <USelect
          v-model="shadowModel"
          data-test="graphics-shadows"
          :items="shadowItems"
          class="w-full"
        />
      </UFormField>
      <UFormField label="Frame cap" name="frame-cap">
        <USelect
          v-model="frameCapModel"
          data-test="graphics-frame-cap"
          :items="frameCapItems"
          class="w-full"
        />
      </UFormField>
    </div>
  </div>
</template>
