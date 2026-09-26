<script setup lang="ts">
import type { PlaybackRate } from '#shared/utils/client'
import type { SlopeProfile } from '#shared/utils/client/instruments'
import { revealedAreaM2, slopeProfile } from '#shared/utils/client/instruments'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import { rankSubmissions } from '#shared/utils/mission'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import MissionMap from '~/components/map/MissionMap.vue'
import type { MissionStateJson } from '~/composables/useMissionState'
import InstrumentGrid from './InstrumentGrid.vue'
import PlaybackControls from './PlaybackControls.vue'
import VoteCard from './VoteCard.vue'

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

/** Instrument updates per second: enough to read, cheap next to the map's per-frame overlay. */
const INSTRUMENT_HZ = 10
/** Most points of the driven path drawn; longer drives are thinned evenly. */
const DRIVEN_POINTS = 400

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const QX = KEYFRAME_FIELDS.indexOf('qx')
const QY = KEYFRAME_FIELDS.indexOf('qy')
const QZ = KEYFRAME_FIELDS.indexOf('qz')
const QW = KEYFRAME_FIELDS.indexOf('qw')

const { loggedIn, user } = useUserSession()
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

/** What the instruments and controls read, sampled at {@link INSTRUMENT_HZ}. */
const snapshot = useThrottled(
  () => ({
    frame: playback.frame.value,
    keyframes: playback.keyframes.value,
    events: playback.events.value,
    reveals: playback.reveals.value,
    heldReveals: playback.heldReveals.value,
    t: playback.simTime.value,
    liveTime: playback.liveTime.value,
    heldUntil: playback.heldUntil.value,
    mode: playback.mode.value,
    rate: playback.rate.value,
  }),
  INSTRUMENT_HZ,
)

/** The rover at the playback frame: the overlay is the one layer that moves every frame. */
const rover = computed(() => {
  const f = playback.frame.value
  if (!f) return undefined
  const [x, y, z, w] = [f[QX]!, f[QY]!, f[QZ]!, f[QW]!]
  // Yaw of the world-from-body quaternion Rz(heading) · Ry(pitch) · Rx(roll).
  return {
    x: f[X]!,
    y: f[Y]!,
    headingRad: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  }
})

/** The route followed at the playback time: the latest replan's, else the opening plan. */
const plan = computed<MapPoint[]>(() => {
  const replan = snapshot.value.events.findLast(
    (e) => e.type === 'replan' && Array.isArray(e.details?.polyline),
  )
  if (replan) return replan.details!.polyline as MapPoint[]
  return playback.manifest.value?.plan.polyline ?? []
})

const driven = computed<MapPoint[]>(() => {
  const block = snapshot.value.keyframes
  if (!block || block.count < 2) return []
  const step = Math.max(1, Math.ceil(block.count / DRIVEN_POINTS))
  const points: MapPoint[] = []
  for (let k = 0; k < block.count; k += step) {
    points.push({
      x: block.data[k * KEYFRAME_STRIDE + X]!,
      y: block.data[k * KEYFRAME_STRIDE + Y]!,
    })
  }
  const last = (block.count - 1) * KEYFRAME_STRIDE
  points.push({ x: block.data[last + X]!, y: block.data[last + Y]! })
  return points
})

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

/* The round. */

const highlightId = ref<string | null>(null)
const highlight = computed<{ id: string; goal: MapPoint } | null>(() => {
  const s = round.value?.submissions.find((entry) => entry.id === highlightId.value)
  return s ? { id: s.id, goal: s.goal } : null
})
function toggleHighlight(id: string): void {
  highlightId.value = highlightId.value === id ? null : id
}

/** Standing order: the submission that would win now comes first. */
const ranked = computed(() => {
  const s = props.state
  if (!s?.round) return []
  return rankSubmissions(
    s.round.submissions.map((entry) => ({
      ...entry,
      createdAt: new Date(entry.createdAt),
      judgment: { ...entry.judgment, risk: { score: entry.judgment.risk } },
      source: entry,
    })),
    { rules: s.mission.rules },
  ).map((entry) => entry.source)
})

const likedIds = ref<string[]>([])
async function loadLikes(): Promise<void> {
  if (!loggedIn.value || !round.value) {
    likedIds.value = []
    return
  }
  const liked = await $fetch('/api/mission/likes').catch(() => null)
  likedIds.value = liked?.submissionIds ?? []
}
watch([loggedIn, () => round.value?.id], loadLikes, { immediate: true })

async function like(id: string, on: boolean): Promise<void> {
  await $fetch(`/api/mission/submissions/${id}/like`, { method: on ? 'PUT' : 'DELETE' }).catch(
    () => undefined,
  )
  emit('changed')
  await loadLikes()
}
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
          <section data-test="round" class="space-y-2" aria-labelledby="round-heading">
            <div class="flex items-baseline justify-between gap-2">
              <h2 id="round-heading" class="text-sm font-semibold">Next destination</h2>
              <span class="text-xs text-muted">
                {{
                  state.segment
                    ? 'Vote closes when the drive ends'
                    : `Stop ${state.currentStop.index}`
                }}
              </span>
            </div>
            <p v-if="!loggedIn" class="text-xs text-muted">
              <ULink to="/login" class="underline">Sign in</ULink> to like or submit a destination.
            </p>
            <p v-if="!round" data-test="round-empty" class="text-sm text-muted">
              No round is open right now.
            </p>
            <p v-else-if="ranked.length === 0" data-test="round-empty" class="text-sm text-muted">
              <template v-if="state.segment">
                No destinations yet for the next drive: pick one inside the ring around the planned
                goal.
              </template>
              <template v-else>
                The rover is idle at stop {{ state.currentStop.index }}: the first destination
                picked inside the ring starts a
                {{ Math.round(state.mission.rules.graceWindowMs / 60_000) }}-minute vote.
              </template>
            </p>
            <VoteCard
              v-for="s in ranked"
              :key="s.id"
              :submission="s"
              :anchor="round!.anchor"
              :liked="likedIds.includes(s.id)"
              :mine="s.submitter.id === user?.id"
              :signed-in="loggedIn"
              :highlighted="s.id === highlightId"
              @like="like(s.id, $event)"
              @highlight="toggleHighlight(s.id)"
            />
          </section>
        </MissionMap>
      </ClientOnly>

      <InstrumentGrid
        :drive="drive"
        :sols-epoch="state.mission.solsEpoch"
        :now-ms="nowMs"
        :round="round"
        :driving="state.segment !== null"
        :rules="state.mission.rules"
        :tally="state.tally"
        :cell-size="ground?.cellSize"
        :slope-limit-deg="ground?.slopeLimitDeg"
      />
    </template>
  </div>
</template>
