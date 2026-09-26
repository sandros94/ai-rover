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
import type { DriveJson, PlaylistJson } from '~/composables/useJourney'
import { driveRoute } from '~/composables/useJourney'
import { INSTRUMENT_HZ } from '~/composables/usePlaybackTrack'
import DriveRow from './DriveRow.vue'

/**
 * Settled drives played back to back, each over the disk of the stop it left with that stop's
 * mask as stored: the fog is what the rover knew then, lifted by the drive's own reveals as it
 * plays. The disk, the judgment and the instruments switch at each stop; with more than one
 * drive an indicator names which of how many plays, and `n` and `p` jump between them. A
 * replay played to its end marks this browser as having seen up to its last drive.
 */
const props = withDefaults(
  defineProps<{
    /** Consecutive settled drives, oldest first; one for a single segment's replay. */
    drives: DriveJson[]
    mission: PlaylistJson['mission']
    /** The stops reached up to the one the first drive left. */
    trail: PlaylistJson['trail']
    /** Where to continue once these are watched, if anywhere. */
    next?: { to: string; number: number } | null
  }>(),
  { next: null },
)

/** Replays start from the beginning at this speed, times real time. */
const START_RATE: PlaybackRate = 60
/** How long the notice of a new segment stays up, milliseconds. */
const TRANSITION_NOTICE_MS = 4000

const rules = computed(() => props.mission.rules)
const multi = computed(() => props.drives.length > 1)

const playback = useSegmentPlaylist(props.drives, {
  missionId: props.mission.id,
  rate: START_RATE,
})
const drive = playback.segment
const { snapshot, rover, plan, driven } = usePlaybackTrack(playback)
/** Playlist time at the instruments' rate: the controls and the status need no more. */
const time = useThrottled(() => playback.time.value, INSTRUMENT_HZ)

const { manifest, mask, cache, sampler, loaded, total, terrain, revealed, error } = playback.terrain
const view = useMapView()
const heightAt = (x: number, y: number) => sampler.value?.heightAt(x, y)

const cellSize = computed(() => terrain.value?.grid.cellSize ?? 1)
/** The stops reached before the drive playing, those the earlier drives left included. */
const trail = computed(() => {
  const stops = new Map(props.trail.map((s) => [s.index, s]))
  for (const d of props.drives.slice(1, playback.index.value + 1)) {
    const { index, x, y } = d.from
    stops.set(index, { index, x, y })
  }
  return [...stops.values()].sort((a, b) => a.index - b.index)
})
/** Where the drives played so far failed, the one playing included. */
const deaths = computed(() =>
  props.drives.slice(0, playback.index.value + 1).flatMap((d) => (d.death ? [d.death] : [])),
)

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
  trail: trail.value,
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
  const { rate, paused } = snapshot.value
  return { mode: 'replay' as const, t: time.value, rate, paused, live: false }
})

/** A new segment is announced for a moment as playback enters it. */
const notice = shallowRef<DriveJson | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined
playback.onTransition((to) => {
  notice.value = props.drives[to]!
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), TRANSITION_NOTICE_MS)
})
onBeforeUnmount(() => clearTimeout(noticeTimer))

const replayed = useReplayedUntil()
watch(playback.ended, (ended) => {
  if (ended) replayed.mark(props.drives.at(-1)!.endedAt)
})

const shortcuts = computed(() =>
  multi.value
    ? [
        { key: 'n', label: 'Next segment', run: playback.next },
        { key: 'p', label: 'Previous segment', run: playback.previous },
      ]
    : [],
)

/** A replay has no vote and no live tally. */
const PANELS: PanelId[] = ['map2d', 'segment', 'clock', ...DRIVE_GROUPS]
const instrumentGroups = ['clock', ...DRIVE_GROUPS] as const

const instrumentProps = computed(() => ({
  drive: instruments.value,
  solsEpoch: props.mission.solsEpoch,
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
    :shortcuts="shortcuts"
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
      <div v-if="multi" class="flex min-w-0 items-center gap-1" data-test="segment-indicator">
        <UButton
          data-test="segment-previous"
          icon="i-lucide-skip-back"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Previous segment"
          @click="playback.previous"
        />
        <h1 class="truncate text-base font-semibold">Segment {{ drive.number }}</h1>
        <UBadge color="neutral" variant="subtle" size="sm" class="shrink-0 tabular-nums">
          {{ playback.index.value + 1 }} of {{ drives.length }}
        </UBadge>
        <span class="hidden truncate text-sm text-muted md:inline">{{ driveRoute(drive) }}</span>
        <UButton
          data-test="segment-next"
          icon="i-lucide-skip-forward"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Next segment"
          :disabled="playback.index.value >= drives.length - 1"
          @click="playback.next"
        />
      </div>
      <h1 v-else class="truncate text-base font-semibold">Segment {{ drive.number }}</h1>
      <UButton
        v-if="next"
        :to="next.to"
        data-test="next-segment"
        icon="i-lucide-chevrons-right"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="`Continue with segment ${next.number}`"
      >
        <span class="hidden lg:inline">Continue with segment {{ next.number }}</span>
      </UButton>
    </template>
    <template #scene>
      <LiveStage :stage="readStage" :view="view" />
    </template>
    <template #top>
      <Transition
        enter-from-class="opacity-0 -translate-y-2"
        leave-to-class="opacity-0 -translate-y-2"
        enter-active-class="transition duration-300"
        leave-active-class="transition duration-300"
      >
        <div
          v-if="notice"
          data-test="segment-transition"
          role="status"
          class="rounded-lg bg-(--ui-bg)/90 px-3 py-1.5 text-sm shadow-lg ring ring-(--ui-border) backdrop-blur-sm"
        >
          <span class="font-semibold">Segment {{ notice.number }}</span>
          <span class="text-muted"> · {{ driveRoute(notice) }}</span>
        </div>
      </Transition>
    </template>
    <template #bottom>
      <PlaybackControls
        :sim-time="time"
        :released-until="playback.duration"
        mode="replay"
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
      <section :key="drive.id" class="space-y-2 p-3" data-test="segment" aria-label="This segment">
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
