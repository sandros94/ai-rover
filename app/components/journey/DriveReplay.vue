<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import { slopeProfile } from '#shared/utils/client/instruments'
import { revealedVertexCount } from '#shared/utils/terrain'
import type { PanelId } from '#shared/utils/client/hud'
import { DRIVE_GROUPS } from '~/components/dashboard/Instrument.vue'
import Instrument from '~/components/dashboard/Instrument.vue'
import PlaybackControls from '~/components/dashboard/PlaybackControls.vue'
import SceneHud from '~/components/hud/SceneHud.vue'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import type { StageProps } from '~/components/map/LiveStage.vue'
import LiveStage from '~/components/map/LiveStage.vue'
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

/** The stage's props: changes every animation frame, so it is read where the stage draws. */
const stage = computed((): StageProps => ({
  terrain: terrain.value,
  seen: revealed.value,
  reveals: snapshot.value.reveals,
  chunkVertices: cache.value?.geometry?.vertexCount,
  heightAt,
  loading: { loaded: loaded.value, total: total.value, error: error.value ?? playback.error.value },
  center: manifest.value ? manifest.value.stop : drive.value.from,
  radius: manifest.value?.radius ?? 500,
  rover: rover.value ?? { ...drive.value.from, headingRad: 0 },
  trail: props.replay.trail,
  plan: plan.value,
  driven: driven.value,
  deaths: deaths.value,
  deathRadiusM: rules.value.failureZone.destinationRadiusM,
  frame: playback.frame.value,
  keyframes: snapshot.value.keyframes,
  t: snapshot.value.t,
}))
const readStage = () => stage.value

const hudPlayback = computed(() => {
  if (!playback.manifest.value) return null
  const { mode, t, rate, paused } = snapshot.value
  return { mode, t, rate, paused, live: false }
})

/** A replay has no vote and no live tally. */
const PANELS: PanelId[] = ['map2d', 'segment', 'clock', ...DRIVE_GROUPS]
const instrumentGroups = ['clock', ...DRIVE_GROUPS] as const

const instrumentProps = computed(() => ({
  drive: instruments.value,
  solsEpoch: props.replay.mission.solsEpoch,
  nowMs: nowMs.value,
  cellSize: cellSize.value,
  slopeLimitDeg: manifest.value?.world.slopeLimitDeg,
}))
</script>

<template>
  <SceneHud
    v-model:view="view"
    :panels="PANELS"
    :playback="hudPlayback"
    @toggle="playback.togglePlay"
  >
    <template #title>
      <UButton
        to="/drives"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Back to the journey"
      />
      <h1 class="truncate text-base font-semibold">Segment {{ drive.number }}</h1>
    </template>
    <template #scene>
      <LiveStage :stage="readStage" :view="view" />
    </template>
    <template #bottom>
      <PlaybackControls
        v-if="hudPlayback"
        :sim-time="snapshot.t"
        :released-until="snapshot.heldUntil"
        :mode="snapshot.mode"
        :rate="snapshot.rate"
        :paused="snapshot.paused"
        :live="false"
        @seek="playback.seek"
        @rate="(rate: PlaybackRate) => playback.setRate(rate)"
        @toggle="playback.togglePlay"
      />
    </template>
    <template #panel-map2d>
      <LiveStage :stage="readStage" view="2d" />
    </template>
    <template #panel-segment>
      <section class="space-y-2 p-3" data-test="segment" aria-label="This segment">
        <DriveRow :drive="drive" />
        <p v-if="drive.reasons.length" class="text-xs text-muted" data-test="drive-reasons">
          Ended: {{ drive.reasons.join(', ') }}
        </p>
        <JudgmentCard :judgment="drive.judgment" />
      </section>
    </template>
    <template v-for="group in instrumentGroups" #[`panel-${group}`]>
      <Instrument :group="group" v-bind="instrumentProps" />
    </template>
  </SceneHud>
</template>
