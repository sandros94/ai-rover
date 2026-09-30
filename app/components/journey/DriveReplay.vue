<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import {
  chunkVerticesOf,
  mapObjects,
  replayedStopsAndDeaths,
  ROVER_ID,
  roverObject,
} from '#shared/utils/client'
import { slopeProfile, solTime } from '#shared/utils/client/instruments'
import { revealedVertexCount } from '#shared/utils/terrain'
import type { PanelId } from '#shared/utils/client/hud'
import { DRIVE_GROUPS } from '~/components/dashboard/Instrument.vue'
import Instrument from '~/components/dashboard/Instrument.vue'
import PlaybackControls from '~/components/dashboard/PlaybackControls.vue'
import SceneHud from '~/components/hud/SceneHud.vue'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import { objectTitle } from '~/components/inspect/ObjectCard.vue'
import ObjectDetails from '~/components/inspect/ObjectDetails.vue'
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
 * replay played to its end marks this browser as having seen up to its last drive. The stops and
 * deaths shown are inspectable as on the live map: a card on hover, and focus with its details.
 */
const props = withDefaults(
  defineProps<{
    /** Consecutive settled drives, oldest first; one for a single segment's replay. */
    drives: DriveJson[]
    mission: PlaylistJson['mission']
    /** The stops reached up to the one the first drive left. */
    trail: PlaylistJson['trail']
    /** The deaths public when the first drive started. */
    deaths?: PlaylistJson['deaths']
    /** Where to continue once these are watched, if anywhere. */
    next?: { to: string; number: number } | null
  }>(),
  { next: null, deaths: () => [] },
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
const { snapshot, rover, plan, driven, motion } = usePlaybackTrack(playback)
/** Playlist time at the instruments' rate: the controls and the status need no more. */
const time = useThrottled(() => playback.time.value, INSTRUMENT_HZ)

const { manifest, mask, sampler, loaded, total, ground, terrain, revealed, error } =
  playback.terrain
const view = useMapView()
const heightAt = (x: number, y: number) => sampler.value?.heightAt(x, y)

const cellSize = computed(() => terrain.value?.grid.cellSize ?? 1)
/**
 * The stops reached before the drive playing, those the earlier drives reached included, and
 * where the drives played so far failed, the one playing included.
 */
const shown = computed(() =>
  replayedStopsAndDeaths(
    { trail: props.trail, deaths: props.deaths },
    props.drives,
    playback.index.value,
  ),
)
/** The stops shown, the playing drive's from-stop current; apart from the per-frame stage. */
const shownTrail = computed(() =>
  shown.value.trail.map((s) => ({ x: s.x, y: s.y, current: s.index === drive.value.from.index })),
)
/** What can be inspected: the stops and deaths shown; the rover is added where it moves. */
const objects = computed(() =>
  mapObjects({
    mission: props.mission,
    currentStop: { index: drive.value.from.index },
    ...shown.value,
    departing: {
      segmentId: drive.value.id,
      number: drive.value.number,
      fromIndex: drive.value.from.index,
      toIndex: drive.value.to?.index ?? null,
    },
    round: null,
  }),
)
/** The deaths as objects: the 3D view knows each ghost by its id. */
const deathObjects = computed(() => objects.value.filter((o) => o.kind === 'death'))

const instruments = computed(() => {
  const s = snapshot.value
  const opening = playback.manifest.value?.plan
  if (!opening || !s.frame || !s.keyframes) return null
  const t = terrain.value
  const seen = revealed.value
  return {
    frame: s.frame,
    keyframes: s.keyframes,
    totals: s.totals,
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

/** The rover as playback shows it, else at the stop the drive left; changes every frame. */
const roverAt = computed(() => rover.value ?? { ...drive.value.from, headingRad: 0 })

/** Once for every stage drawn: the fog, sight included, is the same in each view. */
const fog = useStopFog({
  seen: () => revealed.value,
  reveals: () => snapshot.value.reveals,
  ground: () => ground.value ?? terrain.value,
  eye: () => roverAt.value,
  sight: () => {
    const m = manifest.value
    return m && { mastHeight: m.world.mastHeight, radiusM: m.radius }
  },
})

/** The stage's props: changes every animation frame, so it is read where the stage draws. */
const stage = computed((): StageProps => ({
  terrain: terrain.value,
  ground: ground.value,
  fog: fog.value,
  chunkVertices: manifest.value && chunkVerticesOf(manifest.value),
  heightAt,
  loading: { loaded: loaded.value, total: total.value, error: error.value ?? playback.error.value },
  center: manifest.value ? manifest.value.stop : drive.value.from,
  radius: manifest.value?.radius ?? 500,
  mastHeight: manifest.value?.world.mastHeight,
  rover: roverAt.value,
  trail: shownTrail.value,
  plan: plan.value,
  driven: driven.value,
  deaths: deathObjects.value,
  deathRadiusM: rules.value.failureZone.destinationRadiusM,
  frame: playback.frame.value,
  t: snapshot.value.t,
  // The sun as it stood at that moment of the drive.
  solFraction: solTime(
    new Date(props.mission.solsEpoch).getTime(),
    new Date(drive.value.startedAt).getTime() + snapshot.value.t * 1000,
  ).fraction,
  objects: objects.value,
  roverObject: roverObject(roverAt.value, {
    status: 'driving',
    speedMps: motion.value?.speedMps ?? null,
    progress: motion.value?.progress ?? null,
  }),
}))
const readStage = () => stage.value

/* Inspecting: what the map shows can be focused, and the focused object's details open. */

const mapFocus = useMapFocus()
onBeforeUnmount(mapFocus.clear)
const focused = computed(() => {
  const id = mapFocus.focused.value
  const object = id && id !== ROVER_ID ? objects.value.find((o) => o.id === id) : undefined
  return object && (object.kind === 'stop' || object.kind === 'death') ? object : undefined
})
// A focus whose object is not shown (a stop or death of a segment not reached yet) is dropped.
watch(objects, () => {
  const id = mapFocus.focused.value
  if (id && id !== ROVER_ID && !focused.value) mapFocus.clear()
})
const detail = computed(() =>
  focused.value ? { key: focused.value.id, title: objectTitle(focused.value) } : null,
)

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

const shortcuts = computed(() => [
  ...(multi.value
    ? [
        { key: 'n', label: 'Next segment', run: playback.next },
        { key: 'p', label: 'Previous segment', run: playback.previous },
      ]
    : []),
  { key: 'escape', label: 'Clear the focus', run: mapFocus.clear },
])

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
    :detail="detail"
    @toggle="playback.togglePlay"
    @close-detail="mapFocus.clear"
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
      <LiveStage :stage="readStage" view="2d" :progress="false" />
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
    <template #panel-details>
      <ObjectDetails
        v-if="focused"
        :key="focused.id"
        :object="focused"
        :mission-id="mission.id"
        :rules="rules"
      />
    </template>
    <template v-for="group in instrumentGroups" #[`panel-${group}`]>
      <Instrument :group="group" v-bind="instrumentProps" />
    </template>
  </SceneHud>
</template>
