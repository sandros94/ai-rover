<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import { destinationObject, mapObjects, ROVER_ID, roverActivity } from '#shared/utils/client'
import type { SlopeProfile } from '#shared/utils/client/instruments'
import { revealedAreaM2, slopeProfile, solTime } from '#shared/utils/client/instruments'
import type { MapPoint } from '#shared/utils/mission'
import type { PanelId } from '#shared/utils/client/hud'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import SceneHud from '~/components/hud/SceneHud.vue'
import { objectTitle } from '~/components/inspect/ObjectCard.vue'
import ObjectDetails from '~/components/inspect/ObjectDetails.vue'
import LiveStage from '~/components/map/LiveStage.vue'
import type { MapTrack } from '~/components/map/MissionMap.vue'
import MissionMap from '~/components/map/MissionMap.vue'
import PickPreview from '~/components/map/PickPreview.vue'
import type { MapViewMode } from '~/composables/useMapView'
import type { MissionStateJson } from '~/composables/useMissionState'
import { DRIVE_GROUPS, INSTRUMENT_GROUPS } from './Instrument.vue'
import Instrument from './Instrument.vue'
import NotMovingFlag from './NotMovingFlag.vue'
import PlaybackControls from './PlaybackControls.vue'
import RoundPanel from './RoundPanel.vue'
import RoverActivityBadge from './RoverActivityBadge.vue'

const props = withDefaults(
  defineProps<{
    state: MissionStateJson | null
    /** Why the state did not load; a 404 means no mission has landed. */
    error?: unknown
    /** Server minus browser clock, milliseconds; null before the first estimate. */
    serverOffsetMs?: number | null
  }>(),
  { serverOffsetMs: null },
)

/** Something the visitor did changed the mission state: an LGTM, a submission, a flag. */
const emit = defineEmits<{ changed: [] }>()

const { loggedIn } = useUserSession()
/** Replaced at build time; the template compiler cannot parse `import.meta` itself. */
const dev = import.meta.dev

const noMission = computed(
  () => (props.error as { statusCode?: number; status?: number } | null)?.status === 404,
)
const round = computed(() => props.state?.round ?? null)

/** Changes when the rover reaches a new stop, which remounts the map on its terrain. */
const stopKey = computed(() =>
  props.state ? `${props.state.mission.id}:${props.state.currentStop.index}` : null,
)

/** The drive to play: the one in progress, else the last settled one. */
const playing = computed(() => {
  const s = props.state
  if (!s) return null
  if (s.segment) {
    const { id, startedAt, fromStopId } = s.segment
    return { id, startedAt, fromStopId, driving: true, distanceM: 0, endsAt: null }
  }
  if (s.lastSegment) {
    const { id, startedAt, endsAt, fromStopId, status, distanceM } = s.lastSegment
    return { id, startedAt, fromStopId, driving: false, status, distanceM, endsAt }
  }
  return null
})

const display = useDisplayClock(() => props.serverOffsetMs)
const playback = useSegmentPlayback(playing, {
  display,
  serverOffsetMs: () => props.serverOffsetMs,
})

const { snapshot, rover, plan, driven, motion } = usePlaybackTrack(playback)

/**
 * A drive in progress from the current stop lifts its reveals from the fog as it plays, read with
 * its frame rather than at the instruments' rate. Once settled the stop's own mask decides: it
 * holds an arrival's reveals and never a failure's.
 */
const fogReveals = computed(() => {
  const p = playing.value
  return p?.driving && p.fromStopId === props.state?.currentStop.id ? playback.reveals.value : []
})

const ground = shallowRef<{
  grid: HeightGrid
  origin: GridCell
  revealed: Uint8Array
  cellSize: number
  slopeLimitDeg: number
  revealedM2: number
}>()
watch(stopKey, () => (ground.value = undefined))

const profile = computed<SlopeProfile | undefined>(() => {
  const polyline = playback.manifest.value?.plan.polyline
  const g = ground.value
  return polyline && g && polyline.length > 1 ? slopeProfile(polyline, g) : undefined
})

/** The display clock, read once a second for the countdowns. */
const nowMs = ref(display.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => (nowMs.value = display.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticker))

const drive = computed(() => {
  const p = playing.value
  const s = snapshot.value
  const manifest = playback.manifest.value
  if (!p || !manifest || !s.frame || !s.keyframes || !props.state) return null
  const cellSize = ground.value?.cellSize ?? 1
  const revealedM2 = ground.value?.revealedM2 ?? 0
  // A settled arrival or stop short is already in the tally and in the stop's mask.
  const counted = !p.driving && p.status !== 'failed'
  return {
    frame: s.frame,
    keyframes: s.keyframes,
    totals: s.totals,
    events: s.events,
    reveals: s.reveals,
    t: s.t,
    startedAt: p.startedAt,
    metrics: manifest.plan.metrics,
    profile: profile.value,
    missionBeforeM: props.state.tally.distanceM - (p.driving ? 0 : p.distanceM),
    journeyBeforeM2: Math.max(
      0,
      revealedM2 - (counted ? revealedAreaM2(s.heldReveals, Infinity, cellSize) : 0),
    ),
  }
})

const lagS = computed(() =>
  playing.value
    ? (nowMs.value - Date.parse(String(playing.value.startedAt))) / 1000 - snapshot.value.t
    : null,
)

function onRate(rate: PlaybackRate): void {
  playback.setRate(rate)
}

const activity = computed(() =>
  props.state ? roverActivity(props.state, playback.liveStatus.value) : null,
)

const hudPlayback = computed(() => {
  if (!playing.value || !playback.manifest.value) return null
  const { mode, t, rate, paused } = snapshot.value
  return { mode, t, rate, paused, live: true }
})

/** Read where the map draws them: see `MapTrack`. */
const track: MapTrack = {
  rover,
  plan,
  driven,
  reveals: fogReveals,
  settledUntil: playback.jumpedTo,
  playing: computed(() => playing.value !== null),
  frame: playback.frame,
  t: computed(() => snapshot.value.t),
  motion,
  // The sun of the moment a drive shows while it plays, else of now.
  solFraction: computed(() => {
    const s = props.state
    if (!s) return undefined
    const p = playing.value
    const at = p?.driving ? new Date(p.startedAt).getTime() + snapshot.value.t * 1000 : nowMs.value
    return solTime(new Date(s.mission.solsEpoch).getTime(), at).fraction
  }),
}

const instruments = computed(() => {
  const s = props.state
  return {
    drive: drive.value,
    solsEpoch: s?.mission.solsEpoch ?? 0,
    nowMs: nowMs.value,
    live: s
      ? { round: round.value, driving: s.segment !== null, rules: s.mission.rules, tally: s.tally }
      : undefined,
    cellSize: ground.value?.cellSize,
    slopeLimitDeg: ground.value?.slopeLimitDeg,
  }
})

/** The drive's instruments are offered only while a drive plays. */
const panels = computed<PanelId[]>(() => [
  'map2d',
  'vote',
  ...INSTRUMENT_GROUPS.filter((group) => drive.value || !DRIVE_GROUPS.includes(group)),
])

/* Planning: destinations are picked on the 2D map; a pick from the scene returns to it. */

const view = useMapView()
/** The ground the scene's camera shows, drawn on the floating 2D map. */
const cone = useViewCone(view)
const { report: reportCamera, footprint: viewCone } = cone
const planFrom = ref<MapViewMode | null>(null)
function planOnMap(): void {
  planFrom.value = view.value
  view.value = '2d'
}
function onSubmitted(): void {
  if (planFrom.value) view.value = planFrom.value
  planFrom.value = null
  emit('changed')
}

/* The round: the card whose route the map shows. */

const highlightId = ref<string | null>(null)
const highlight = computed<{ id: string; goal: MapPoint } | null>(() => {
  const s = round.value?.submissions.find((entry) => entry.id === highlightId.value)
  return s ? { id: s.id, goal: s.goal } : null
})

/* Inspecting: what the map shows can be focused, and the focused object's details open. */

const mapFocus = useMapFocus()
onBeforeUnmount(mapFocus.clear)
/** The state's objects, and the destination where the route the drive follows now ends. */
const objects = computed(() => {
  const state = props.state
  if (!state) return []
  const destination = destinationObject(state, plan.value)
  return destination ? [...mapObjects(state), destination] : mapObjects(state)
})
const focused = computed(() => {
  const id = mapFocus.focused.value
  const object = id && id !== ROVER_ID ? objects.value.find((o) => o.id === id) : undefined
  return object && object.kind !== 'rover' ? object : undefined
})
// A focus whose object left the state (a round closed, a new stop) is dropped.
watch(objects, () => {
  const id = mapFocus.focused.value
  if (props.state && id && id !== ROVER_ID && !focused.value) mapFocus.clear()
})
// A focused submission's route is drawn; moving the focus off it hides the route again.
watch(focused, (next, previous) => {
  if (next?.kind === 'submission') highlightId.value = next.submissionId
  else if (previous?.kind === 'submission' && highlightId.value === previous.submissionId) {
    highlightId.value = null
  }
})
const detail = computed(() =>
  focused.value ? { key: focused.value.id, title: objectTitle(focused.value) } : null,
)
const focusedSubmission = computed(() => {
  const object = focused.value
  return object?.kind === 'submission'
    ? round.value?.submissions.find((s) => s.id === object.submissionId)
    : undefined
})
const shortcuts = [{ key: 'escape', label: 'Clear the focus', run: mapFocus.clear }]
</script>

<template>
  <ClientOnly>
    <MissionMap
      v-if="state && stopKey"
      :key="stopKey"
      v-slot="{ stage, planning }"
      :state="state"
      :signed-in="loggedIn"
      :highlight="highlight"
      :track="track"
      :objects="objects"
      @submitted="onSubmitted"
      @stale="emit('changed')"
      @ground="ground = $event"
    >
      <SceneHud
        v-model:view="view"
        :panels="panels"
        :playback="hudPlayback"
        :shortcuts="shortcuts"
        :detail="detail"
        @toggle="playback.togglePlay"
        @live="playback.goLive"
        @close-detail="mapFocus.clear"
      >
        <template #status>
          <RoverActivityBadge v-if="activity" :activity="activity" />
        </template>
        <template #scene>
          <LiveStage
            :stage="stage"
            :view="view"
            :report-camera="reportCamera"
            @hover="planning.onHover"
            @pick="planning.onPick"
            @camera="cone.onCamera"
          />
        </template>
        <template #top>
          <UAlert
            v-if="state.pause"
            data-test="pause"
            class="max-w-xl"
            color="warning"
            variant="subtle"
            icon="i-lucide-circle-pause"
            title="The mission is paused: submissions and LGTMs wait until it resumes."
            :description="state.pause.message"
          >
            <template #actions>
              <span class="flex items-center gap-1 text-xs text-muted">
                <UAvatar
                  :src="state.pause.by.avatarUrl ?? undefined"
                  :alt="state.pause.by.displayName"
                  size="3xs"
                />
                {{ state.pause.by.displayName }}
              </span>
            </template>
          </UAlert>
          <PickPreview
            v-if="view === '2d'"
            data-test="pick-preview"
            class="w-full max-w-sm"
            :result="planning.result"
            :pending="planning.pending"
            :picked="planning.picked"
            :submitting="planning.submitting"
            :refusal="planning.refusal"
            :signed-in="loggedIn"
            @confirm="planning.confirm"
            @cancel="planning.cancel"
          />
          <UButton
            v-else-if="state.round"
            data-test="plan-on-map"
            icon="i-lucide-map-pin"
            color="neutral"
            variant="solid"
            class="shadow-lg"
            @click="planOnMap"
          >
            Plan on the 2D map
          </UButton>
        </template>
        <template #bottom>
          <PlaybackControls
            v-if="hudPlayback"
            :sim-time="snapshot.t"
            :released-until="Math.min(snapshot.liveTime, snapshot.heldUntil)"
            :mode="snapshot.mode"
            :rate="snapshot.rate"
            :paused="snapshot.paused"
            :lag-s="lagS"
            @seek="playback.seek"
            @rate="onRate"
            @toggle="playback.togglePlay"
            @live="playback.goLive"
          />
        </template>
        <template #panel-map2d>
          <LiveStage
            :stage="stage"
            view="2d"
            :progress="false"
            :view-cone="viewCone"
            @vue:mounted="cone.shown"
            @vue:unmounted="cone.hidden"
          />
        </template>
        <template #panel-vote>
          <div class="space-y-3 p-3">
            <NotMovingFlag
              v-if="state.segment && state.flags"
              :segment-id="state.segment.id"
              :flags="state.flags"
              :signed-in="loggedIn"
              @changed="emit('changed')"
            />
            <RoundPanel
              v-model:highlight-id="highlightId"
              :state="state"
              @changed="emit('changed')"
            />
          </div>
        </template>
        <template #panel-details>
          <ObjectDetails
            v-if="focused"
            :key="focused.id"
            :object="focused"
            :rules="state.mission.rules"
            :submission="focusedSubmission"
          />
        </template>
        <template v-for="group in INSTRUMENT_GROUPS" #[`panel-${group}`]>
          <Instrument :group="group" v-bind="instruments" />
        </template>
      </SceneHud>
    </MissionMap>
    <SceneHud v-else v-model:view="view" :panels="[]">
      <template #top>
        <div class="w-full max-w-xl">
          <UAlert
            v-if="noMission"
            color="neutral"
            variant="subtle"
            icon="i-lucide-rocket"
            title="No mission has landed yet."
            description="The dashboard fills in once a rover is on the ground."
          >
            <template v-if="dev" #actions>
              <UButton to="/_dev" size="sm" variant="soft" icon="i-lucide-wrench">
                Seed one in the dev panel
              </UButton>
            </template>
          </UAlert>
          <UAlert
            v-else-if="error && !state"
            color="error"
            variant="subtle"
            title="The mission state did not load."
          />
          <p v-else class="text-sm text-muted">Loading the mission…</p>
        </div>
      </template>
    </SceneHud>
    <template #fallback>
      <SceneHud :view="view" :panels="[]" />
    </template>
  </ClientOnly>
</template>
