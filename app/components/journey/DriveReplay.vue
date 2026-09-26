<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import { slopeProfile } from '#shared/utils/client/instruments'
import { revealedVertexCount } from '#shared/utils/terrain'
import InstrumentGrid from '~/components/dashboard/InstrumentGrid.vue'
import PlaybackControls from '~/components/dashboard/PlaybackControls.vue'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import StopStage from '~/components/map/StopStage.vue'
import type { DriveReplayJson } from '~/composables/useJourney'
import DriveRow from './DriveRow.vue'

/**
 * One settled drive played back over the disk of the stop it left, with that stop's mask as
 * stored: the fog is what the rover knew then, lifted by the drive's own reveals as it plays.
 */
const props = defineProps<{ replay: DriveReplayJson }>()

/** Replays start from the beginning at this speed, times real time. */
const START_RATE: PlaybackRate = 60

const drive = computed(() => props.replay.drive)
const rules = computed(() => props.replay.mission.rules)

const playback = useSegmentPlayback(() => drive.value.id)
const { snapshot, rover, plan, driven } = usePlaybackTrack(playback)
watch(playback.manifest, (manifest) => {
  if (!manifest) return
  playback.setRate(START_RATE)
  playback.seek(0)
})

const { manifest, mask, cache, sampler, loaded, total, terrain, revealed, error } = useStopTerrain(
  props.replay.mission.id,
  drive.value.from.index,
)
const view = useMapView()
const heightAt = (x: number, y: number) => sampler.value?.heightAt(x, y)

const cellSize = computed(() => terrain.value?.grid.cellSize ?? 1)
const deaths = computed(() => (drive.value.death ? [drive.value.death] : []))

const instruments = computed(() => {
  const s = snapshot.value
  const opening = playback.manifest.value?.plan
  if (!opening || !s.frame || !s.keyframes) return null
  const t = terrain.value
  const seen = revealed.value
  return {
    frame: s.frame,
    keyframes: s.keyframes,
    events: s.events,
    reveals: s.reveals,
    t: s.t,
    startedAt: drive.value.startedAt,
    metrics: opening.metrics,
    profile:
      t && seen && opening.polyline.length > 1
        ? slopeProfile(opening.polyline, { grid: t.grid, origin: t.origin, revealed: seen })
        : undefined,
    missionBeforeM: drive.value.journeyBeforeM,
    // The from-stop's mask is the journey's seen ground before this drive.
    journeyBeforeM2: mask.value ? revealedVertexCount(mask.value) * cellSize.value ** 2 : 0,
  }
})

const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => (nowMs.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticker))
</script>

<template>
  <div class="space-y-4">
    <DriveRow :drive="drive" />
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="space-y-2">
        <StopStage
          v-model:view="view"
          :terrain="terrain"
          :seen="revealed"
          :reveals="snapshot.reveals"
          :chunk-vertices="cache?.geometry?.vertexCount"
          :height-at="heightAt"
          :loading="{ loaded, total, error: error ?? playback.error.value }"
          :center="manifest ? manifest.stop : drive.from"
          :radius="manifest?.radius ?? 500"
          :rover="rover ?? { ...drive.from, headingRad: 0 }"
          :trail="replay.trail"
          :plan="plan"
          :driven="driven"
          :deaths="deaths"
          :death-radius-m="rules.failureZone.destinationRadiusM"
          :frame="playback.frame.value"
          :keyframes="snapshot.keyframes"
          :t="snapshot.t"
        />
        <PlaybackControls
          v-if="playback.manifest.value"
          :sim-time="snapshot.t"
          :released-until="snapshot.heldUntil"
          :mode="snapshot.mode"
          :rate="snapshot.rate"
          :live="false"
          @seek="playback.seek"
          @rate="(rate: PlaybackRate) => playback.setRate(rate)"
        />
      </div>
      <section class="space-y-2" aria-labelledby="judgment-heading">
        <h2 id="judgment-heading" class="text-sm font-semibold">Jev's judgment of this route</h2>
        <p v-if="drive.reasons.length" class="text-xs text-muted" data-test="drive-reasons">
          Ended: {{ drive.reasons.join(', ') }}
        </p>
        <JudgmentCard :judgment="drive.judgment" />
      </section>
    </div>
    <InstrumentGrid
      :drive="instruments"
      :sols-epoch="replay.mission.solsEpoch"
      :now-ms="nowMs"
      :cell-size="cellSize"
      :slope-limit-deg="manifest?.world.slopeLimitDeg"
    />
  </div>
</template>
