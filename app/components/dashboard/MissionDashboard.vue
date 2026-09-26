<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import type { SlopeProfile } from '#shared/utils/client/instruments'
import { revealedAreaM2, slopeProfile } from '#shared/utils/client/instruments'
import type { MapPoint } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import MissionMap from '~/components/map/MissionMap.vue'
import type { MissionStateJson } from '~/composables/useMissionState'
import InstrumentGrid from './InstrumentGrid.vue'
import PlaybackControls from './PlaybackControls.vue'
import RoundPanel from './RoundPanel.vue'

const props = withDefaults(
  defineProps<{
    state: MissionStateJson | null
    /** Why the state did not load; a 404 means no mission has landed. */
    error?: unknown
    /** Server minus browser clock, milliseconds. */
    serverOffsetMs?: number
  }>(),
  { serverOffsetMs: 0 },
)

/** Something the visitor did changed the mission state: a like, a submission. */
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
    return { id, startedAt, fromStopId, driving: true, distanceM: 0 }
  }
  if (s.lastSegment) {
    const { id, startedAt, fromStopId, status, distanceM } = s.lastSegment
    return { id, startedAt, fromStopId, driving: false, status, distanceM }
  }
  return null
})

const playback = useSegmentPlayback(() => playing.value?.id, {
  serverOffsetMs: () => props.serverOffsetMs,
})

const { snapshot, rover, plan, driven } = usePlaybackTrack(playback)

/**
 * A drive in progress from the current stop lifts its reveals from the fog as it plays. Once
 * settled the stop's own mask decides: it holds an arrival's reveals and never a failure's.
 */
const fogReveals = computed(() => {
  const p = playing.value
  return p?.driving && p.fromStopId === props.state?.currentStop.id ? snapshot.value.reveals : []
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

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticker))
const nowMs = computed(() => now.value + props.serverOffsetMs)

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

/* The round: the card whose route the map shows. */

const highlightId = ref<string | null>(null)
const highlight = computed<{ id: string; goal: MapPoint } | null>(() => {
  const s = round.value?.submissions.find((entry) => entry.id === highlightId.value)
  return s ? { id: s.id, goal: s.goal } : null
})
</script>

<template>
  <div class="space-y-4">
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
    <p v-else-if="!state" class="text-sm text-muted">Loading the mission…</p>

    <template v-if="state && stopKey">
      <ClientOnly>
        <MissionMap
          :key="stopKey"
          :state="state"
          :signed-in="loggedIn"
          :highlight="highlight"
          :rover="rover"
          :plan="plan"
          :driven="driven"
          :reveals="fogReveals"
          :frame="playback.frame.value"
          :keyframes="snapshot.keyframes"
          :t="snapshot.t"
          @submitted="emit('changed')"
          @ground="ground = $event"
        >
          <template #controls>
            <PlaybackControls
              v-if="playing && playback.manifest.value"
              :sim-time="snapshot.t"
              :released-until="Math.min(snapshot.liveTime, snapshot.heldUntil)"
              :mode="snapshot.mode"
              :rate="snapshot.rate"
              :lag-s="lagS"
              @seek="playback.seek"
              @rate="onRate"
              @live="playback.goLive"
            />
          </template>
          <RoundPanel
            v-model:highlight-id="highlightId"
            :state="state"
            @changed="emit('changed')"
          />
        </MissionMap>
      </ClientOnly>

      <InstrumentGrid
        :drive="drive"
        :sols-epoch="state.mission.solsEpoch"
        :now-ms="nowMs"
        :live="{
          round,
          driving: state.segment !== null,
          rules: state.mission.rules,
          tally: state.tally,
        }"
        :cell-size="ground?.cellSize"
        :slope-limit-deg="ground?.slopeLimitDeg"
      />
    </template>
  </div>
</template>
