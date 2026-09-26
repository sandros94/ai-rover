<script lang="ts">
import type { MapObject, MarsMoment, RoverStatus } from '#shared/utils/client'
import { RISK, VERDICT } from '~/components/instruments/JudgmentCard.vue'

/** Jev's expected risk level as its word. */
export const riskWord = (risk: number): string => RISK[Math.round(risk)]?.label ?? 'Unknown'
/** A verdict as its word; an unknown one as given. */
export const verdictWord = (verdict: string): string =>
  VERDICT[verdict as keyof typeof VERDICT]?.label ?? verdict

/** The rover's status as a word or two. */
export const ROVER_STATUS: Record<RoverStatus, string> = {
  driving: 'Driving',
  planning: 'Planning phase',
  waiting: 'Waiting for a destination',
}

/** A moment as `Sol 12, 06:00:00 LMST`, the Earth date and time after it. */
export function marsMoment(at: MarsMoment): { sol: string; earth: string } {
  return {
    sol: `Sol ${at.sol}, ${at.lmst} LMST`,
    earth: new Date(at.iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  }
}

/** What an object is called in a card or a panel title. */
export function objectTitle(object: MapObject): string {
  switch (object.kind) {
    case 'stop':
      return object.index === 0 ? 'Stop 0, the landing site' : `Stop ${object.index}`
    case 'death':
      return `Segment ${object.number}: rover lost`
    case 'submission':
      return `${object.author.displayName}'s destination`
    case 'rover':
      return 'The rover'
  }
}
</script>

<script setup lang="ts">
/**
 * The small card of a hovered or tapped object: what it is, when, how far, and its outcome or
 * judgment. Placed by its host; it takes no pointer, so hovering carries on beneath it.
 */
const props = defineProps<{ object: MapObject }>()

const lines = computed((): string[] => {
  const o = props.object
  switch (o.kind) {
    case 'stop': {
      if (!o.reached) return [o.current ? 'Where the rover stands' : 'Where the rover landed']
      const at = marsMoment(o.reached.at)
      return [`Reached by segment ${o.reached.number}`, at.sol, at.earth]
    }
    case 'death': {
      const at = marsMoment(o.at)
      return [
        `Ended: ${o.reasons.join(', ') || 'failed'}`,
        `${o.distanceM.toFixed(1)} m driven from stop ${o.fromIndex}`,
        at.sol,
        at.earth,
      ]
    }
    case 'submission':
      return [
        `${Math.round(o.distanceM)} m · ${o.bearing.degrees}° ${o.bearing.compass}`,
        `${verdictWord(o.verdict)} · ${riskWord(o.risk)} risk`,
        `${o.likes} LGTM`,
      ]
    case 'rover':
      return [
        ROVER_STATUS[o.status],
        ...(o.speedMps === null ? [] : [`${(o.speedMps * 100).toFixed(1)} cm/s`]),
        ...(o.progress === null ? [] : [`${Math.round(o.progress * 100)} % of the segment`]),
      ]
  }
})
</script>

<template>
  <div
    data-test="object-card"
    :data-kind="object.kind"
    role="tooltip"
    class="pointer-events-none w-max max-w-64 rounded-md bg-(--ui-bg)/95 px-2.5 py-1.5 text-xs shadow-lg ring ring-(--ui-border) backdrop-blur-sm"
  >
    <p class="flex items-center gap-1.5 font-semibold">
      <UAvatar
        v-if="object.kind === 'submission'"
        :src="object.author.avatarUrl ?? undefined"
        :alt="object.author.displayName"
        size="3xs"
      />
      {{ objectTitle(object) }}
    </p>
    <p v-for="line in lines" :key="line" class="text-muted tabular-nums">{{ line }}</p>
  </div>
</template>
