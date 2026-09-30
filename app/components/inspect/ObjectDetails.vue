<script setup lang="ts">
import type {
  DeathObject,
  DestinationObject,
  StopObject,
  SubmissionObject,
} from '#shared/utils/client'
import { destinationLines } from '#shared/utils/client'
import type { MissionRules } from '#shared/utils/mission'
import type { StopManifest } from '#shared/utils/terrain'
import JudgmentCard from '~/components/instruments/JudgmentCard.vue'
import type { MissionStateJson } from '~/composables/useMissionState'
import { marsMoment, riskWord } from './ObjectCard.vue'

type Submission = NonNullable<MissionStateJson['round']>['submissions'][number]

/**
 * Everything known about a focused object. A stop: when and by which segment it was reached,
 * its disk as its manifest describes it (fetched when shown), and the segments that left it. A
 * death: its segment, why and when it ended, how far it drove, the zone goals and routes keep
 * clear of, and its replay. A submission: its author, goal, route and Jev's judgment. The
 * destination: the winning author, where it lies, the planned route and arrival.
 */
const props = defineProps<{
  object: StopObject | DeathObject | SubmissionObject | DestinationObject
  rules: MissionRules
  /** The focused submission as the round lists it. */
  submission?: Submission
}>()

const replay = (segmentId: string) => `/drives/${segmentId}`

/** The stop's manifest, once fetched; null when it could not be. */
const manifest = shallowRef<StopManifest | null>()
watch(
  () => (props.object.kind === 'stop' ? props.object.manifestKey : undefined),
  async (key) => {
    manifest.value = undefined
    if (key === undefined) return
    try {
      const fetched = await useJourneyClient().getStopManifest(key)
      if (props.object.kind === 'stop' && props.object.manifestKey === key) manifest.value = fetched
    } catch {
      manifest.value = null
    }
  },
  { immediate: true },
)

const destination = computed(() =>
  props.object.kind === 'destination' ? destinationLines(props.object) : null,
)

const route = computed(() => {
  const r = props.submission?.summary.route
  return r?.reached ? `${r.path_length_m} m path · ${r.estimated_drive_minutes} min` : null
})
</script>

<template>
  <section data-test="object-details" :data-kind="object.kind" class="space-y-3 p-3 text-sm">
    <template v-if="object.kind === 'stop'">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt class="text-muted">Position</dt>
        <dd class="tabular-nums">{{ object.x.toFixed(1) }}, {{ object.y.toFixed(1) }} m</dd>
        <template v-if="object.reached">
          <dt class="text-muted">Reached</dt>
          <dd>
            <ULink :to="replay(object.reached.segmentId)" class="underline">
              by segment {{ object.reached.number }}
            </ULink>
            <span class="block text-muted tabular-nums">
              {{ marsMoment(object.reached.at).sol }} ·
              {{ marsMoment(object.reached.at).earth }}
            </span>
          </dd>
        </template>
        <template v-else>
          <dt class="text-muted">Reached</dt>
          <dd>Landed here</dd>
        </template>
        <template v-if="manifest">
          <dt class="text-muted">Disk</dt>
          <dd data-test="stop-disk" class="tabular-nums">
            {{ manifest.radius }} m radius, {{ manifest.chunks.length }} chunks of
            {{ manifest.world.chunkSize }} m, {{ manifest.world.cellSize }} m cells
          </dd>
          <dt class="text-muted">Mast</dt>
          <dd class="tabular-nums">{{ manifest.world.mastHeight }} m</dd>
          <dt class="text-muted">Slope limit</dt>
          <dd class="tabular-nums">{{ manifest.world.slopeLimitDeg }}°</dd>
        </template>
      </dl>
      <div>
        <h3 class="mb-1 text-xs font-medium text-muted">Segments from this stop</h3>
        <p v-if="object.departures.length === 0" class="text-muted">
          {{ object.current ? 'None yet: the next one leaves from here.' : 'None.' }}
        </p>
        <ul v-else class="space-y-0.5">
          <li v-for="d in object.departures" :key="d.segmentId">
            <ULink data-test="stop-departure" :to="replay(d.segmentId)" class="underline">
              Segment {{ d.number }}
            </ULink>
            <span class="text-muted">
              → {{ d.toIndex === null ? 'lost' : `stop ${d.toIndex}` }}
            </span>
          </li>
        </ul>
      </div>
    </template>

    <template v-else-if="object.kind === 'death'">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt class="text-muted">Segment</dt>
        <dd>{{ object.number }}, from stop {{ object.fromIndex }}</dd>
        <dt class="text-muted">Ended</dt>
        <dd>{{ object.reasons.join(', ') || 'failed' }}</dd>
        <dt class="text-muted">When</dt>
        <dd class="tabular-nums">
          {{ marsMoment(object.at).sol }}
          <span class="block text-muted">{{ marsMoment(object.at).earth }}</span>
        </dd>
        <dt class="text-muted">Driven</dt>
        <dd class="tabular-nums">{{ object.distanceM.toFixed(1) }} m</dd>
        <dt class="text-muted">Death zone</dt>
        <dd data-test="death-zone" class="tabular-nums">
          goals keep {{ rules.failureZone.destinationRadiusM }} m clear, routes
          {{ rules.failureZone.pathRadiusM }} m
        </dd>
      </dl>
      <UButton
        data-test="death-replay"
        :to="replay(object.segmentId)"
        icon="i-lucide-play"
        size="sm"
        color="neutral"
        variant="soft"
      >
        Replay segment {{ object.number }}
      </UButton>
    </template>

    <template v-else-if="object.kind === 'destination'">
      <div class="flex items-center gap-2">
        <UAvatar
          :src="object.author.avatarUrl ?? undefined"
          :alt="object.author.displayName"
          size="xs"
        />
        <span class="font-medium">{{ object.author.displayName }}</span>
      </div>
      <p v-if="destination" class="flex flex-col text-xs text-muted tabular-nums">
        <span>{{ destination.heading }}</span>
        <span v-if="destination.route">{{ destination.route }}</span>
        <span v-if="destination.arrival">{{ destination.arrival }}</span>
      </p>
      <p class="text-xs text-muted">The drive may stop short of it or fail on the way.</p>
    </template>

    <template v-else>
      <div class="flex items-center gap-2">
        <UAvatar
          :src="object.author.avatarUrl ?? undefined"
          :alt="object.author.displayName"
          size="xs"
        />
        <span class="font-medium">{{ object.author.displayName }}</span>
        <span class="ml-auto text-muted tabular-nums">{{ object.likes }} LGTM</span>
      </div>
      <p class="flex flex-wrap gap-x-3 text-xs text-muted tabular-nums">
        <span>
          {{ Math.round(object.distanceM) }} m · {{ object.bearing.degrees }}°
          {{ object.bearing.compass }}
        </span>
        <span v-if="route">{{ route }}</span>
        <span>{{ riskWord(object.risk) }} risk</span>
      </p>
      <JudgmentCard v-if="submission" :judgment="submission.judgment" />
    </template>
  </section>
</template>
