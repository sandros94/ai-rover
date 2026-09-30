<script setup lang="ts">
import type { AttitudeLevel } from '#shared/utils/client/instruments'
import {
  attitudeLevels,
  frameAttitude,
  levelPoint,
  roverLinkage,
  sideView,
} from '#shared/utils/client/instruments'
import type { Point3, ResolvedRoverGeometry } from '#shared/utils/rover'
import { DEFAULT_ROVER_GEOMETRY, DEFAULT_ROVER_LIMITS as L } from '#shared/utils/rover'

const props = defineProps<{
  /** The 23 keyframe values, as `interpolatePose` returns them. */
  frame: Float32Array
  geometry?: ResolvedRoverGeometry
}>()

const G = computed(() => props.geometry ?? DEFAULT_ROVER_GEOMETRY)
const DEG = 180 / Math.PI
/** SVG units per metre. */
const S = 100
/** Body top and mast, metres: drawing proportions only, the solver never uses them. */
const BODY_TOP = 1.1
const MAST = { x: 0.7, top: 2 }

const attitude = computed(() => frameAttitude(props.frame))
const linkage = computed(() => roverLinkage(attitude.value, G.value))
const view = computed(() => sideView(attitude.value, G.value))
const level = (p: Point3) => levelPoint(attitude.value, p)

type Project = (p: Point3) => [number, number]
const side: Project = (p) => [p.x * S, -p.z * S]
const rear: Project = (p) => [-p.y * S, -p.z * S]
const pts = (project: Project, points: Point3[]) =>
  points.map((p) => project(p).join(',')).join(' ')

/** The ground under two contacts, extended to `reach` metres either side along the first axis. */
function groundLine(project: Project, a: Point3, b: Point3, reach: number): string {
  const [ax, ay] = project({ ...a, z: a.z - G.value.wheelRadius })
  const [bx, by] = project({ ...b, z: b.z - G.value.wheelRadius })
  const slope = (by - ay) / (bx - ax || 1)
  const at = (x: number) => `${x},${ay + slope * (x - ax)}`
  return `${at(-reach * S)} ${at(reach * S)}`
}

const body = computed(() => {
  const g = G.value
  const [x0, x1] = [g.bellyOffsetX - g.bellyLength / 2, g.bellyOffsetX + g.bellyLength / 2]
  const w = g.bellyWidth / 2
  return {
    side: [
      { x: x0, y: 0, z: g.bellyClearance },
      { x: x1, y: 0, z: g.bellyClearance },
      { x: x1, y: 0, z: BODY_TOP },
      { x: x0, y: 0, z: BODY_TOP },
    ].map(level),
    rear: [
      { x: 0, y: w, z: g.bellyClearance },
      { x: 0, y: -w, z: g.bellyClearance },
      { x: 0, y: -w, z: BODY_TOP },
      { x: 0, y: w, z: BODY_TOP },
    ].map(level),
    mast: [
      { x: MAST.x, y: 0, z: BODY_TOP },
      { x: MAST.x, y: 0, z: MAST.top },
    ].map(level),
  }
})

/** Rear view, per side: rocker front → pivot → bogie pivot, bogie middle → pivot → rear. */
const arms = computed(() =>
  [1, 0].map((s) => {
    const { wheels: w, rockerPivots: rp, bogiePivots: bp } = linkage.value
    return {
      side: s,
      rocker: [w[s]!, rp[s]!, bp[s]!],
      bogie: [w[2 + s]!, bp[s]!, w[4 + s]!],
    }
  }),
)

const levels = computed(() => attitudeLevels(attitude.value))
const readouts = computed(() => {
  const a = attitude.value
  const l = levels.value
  const row = (id: string, label: string, rad: number, limit: number, lvl: AttitudeLevel) => ({
    id,
    label,
    value: `${(rad * DEG).toFixed(1)}°`,
    limit: `${Math.round(limit * DEG)}°`,
    level: lvl,
  })
  return [
    row('pitch', 'Pitch', a.pitchRad, L.pitchRad, l.pitch),
    row('roll', 'Roll', a.rollRad, L.rollRad, l.roll),
    row('tilt', 'Tilt', a.tiltRad, L.tiltRad, l.tilt),
    row('bogie-left', 'Bogie left', a.bogie.left, L.bogieRad, l.bogieLeft),
    row('bogie-right', 'Bogie right', a.bogie.right, L.bogieRad, l.bogieRight),
    row('differential', 'Differential', a.differentialRad, L.differentialRad, l.differential),
  ]
})
const STATUS = {
  ok: { color: 'var(--viz-good)', icon: 'i-lucide-circle-check', label: 'within limit' },
  warn: { color: 'var(--viz-warning)', icon: 'i-lucide-triangle-alert', label: 'past limit' },
  fail: { color: 'var(--viz-critical)', icon: 'i-lucide-octagon-x', label: 'tip-over' },
} as const
const TREADS = [0, 60, 120, 180, 240, 300]
</script>

<template>
  <UCard class="min-w-60" :ui="{ body: 'p-3 sm:p-4 space-y-3' }">
    <div class="grid gap-3 sm:grid-cols-[3fr_2fr]">
      <figure>
        <svg
          data-test="side-view"
          viewBox="-170 -225 360 270"
          class="w-full"
          role="img"
          :aria-label="`Side view: pitch ${readouts[0]!.value}`"
        >
          <line x1="-170" x2="190" y1="0" y2="0" stroke="var(--viz-grid)" stroke-width="1" />
          <polyline
            :points="
              groundLine(side, view.near.wheels[2]!.center, view.near.wheels[0]!.center, 1.9)
            "
            fill="none"
            stroke="var(--viz-axis)"
            stroke-width="3"
            stroke-linecap="round"
          />
          <g v-for="key in ['far', 'near'] as const" :key="key" :opacity="key === 'far' ? 0.35 : 1">
            <template v-if="key === 'near'">
              <polygon
                :points="pts(side, body.side)"
                class="fill-(--ui-bg-elevated) stroke-(--ui-border-accented)"
                stroke-width="1.5"
              />
              <polyline
                :points="pts(side, body.mast)"
                fill="none"
                class="stroke-(--ui-border-accented)"
                stroke-width="4"
              />
            </template>
            <polyline
              :points="pts(side, view[key].rocker)"
              fill="none"
              stroke="var(--viz-series-1)"
              stroke-width="5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <polyline
              :points="pts(side, view[key].bogie)"
              fill="none"
              stroke="var(--viz-series-2)"
              stroke-width="4"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <g
              v-for="(w, k) in view[key].wheels"
              :key="k"
              data-test="wheel"
              :transform="`translate(${side(w.center).join(' ')})`"
            >
              <circle
                :r="G.wheelRadius * S"
                class="fill-(--ui-bg) stroke-(--ui-text-highlighted)"
                stroke-width="3"
              />
              <g data-test="tread" :transform="`rotate(${(w.spin * 180) / Math.PI})`">
                <line
                  v-for="a in TREADS"
                  :key="a"
                  :transform="`rotate(${a})`"
                  :y1="-G.wheelRadius * S + 2"
                  :y2="-G.wheelRadius * S + 9"
                  class="stroke-(--ui-text-muted)"
                  stroke-width="3"
                />
                <circle r="4" class="fill-(--ui-text-highlighted)" />
              </g>
            </g>
            <circle
              v-for="(p, i) in [view[key].rocker[1], view[key].rocker[2]]"
              :key="i"
              :cx="side(p)[0]"
              :cy="side(p)[1]"
              r="4.5"
              class="fill-(--ui-text-highlighted) stroke-(--ui-bg)"
              stroke-width="2"
            />
          </g>
        </svg>
        <figcaption class="text-xs text-muted">
          Side, right · bogie
          <span class="inline-block size-2 rounded-full bg-(--viz-series-2)" /> rocker
          <span class="inline-block size-2 rounded-full bg-(--viz-series-1)" />
        </figcaption>
      </figure>
      <figure>
        <svg
          data-test="rear-view"
          viewBox="-160 -135 320 180"
          class="w-full"
          role="img"
          :aria-label="`Rear view: roll ${readouts[1]!.value}`"
        >
          <line x1="-160" x2="160" y1="0" y2="0" stroke="var(--viz-grid)" stroke-width="1" />
          <polyline
            :points="groundLine(rear, linkage.wheels[5]!, linkage.wheels[4]!, 1.6)"
            fill="none"
            stroke="var(--viz-axis)"
            stroke-width="3"
            stroke-linecap="round"
          />
          <polygon
            :points="pts(rear, body.rear)"
            class="fill-(--ui-bg-elevated) stroke-(--ui-border-accented)"
            stroke-width="1.5"
          />
          <polyline
            :points="pts(rear, linkage.rockerPivots)"
            fill="none"
            stroke="var(--viz-series-1)"
            stroke-width="4"
            stroke-linecap="round"
          />
          <template v-for="arm in arms" :key="arm.side">
            <polyline
              :points="pts(rear, arm.rocker)"
              fill="none"
              stroke="var(--viz-series-1)"
              stroke-width="3"
              stroke-linejoin="round"
            />
            <polyline
              :points="pts(rear, arm.bogie)"
              fill="none"
              stroke="var(--viz-series-2)"
              stroke-width="3"
              stroke-linejoin="round"
            />
          </template>
          <rect
            v-for="(w, k) in linkage.wheels"
            :key="k"
            data-test="wheel"
            :x="rear(w)[0] - (G.wheelWidth * S) / 2"
            :y="rear(w)[1] - G.wheelRadius * S"
            :width="G.wheelWidth * S"
            :height="G.wheelRadius * S * 2"
            rx="6"
            class="fill-(--ui-bg) stroke-(--ui-text-highlighted)"
            :opacity="k < 4 ? 0.45 : 1"
            stroke-width="3"
          />
        </svg>
        <figcaption class="text-xs text-muted">
          Rear · differential <span class="inline-block size-2 rounded-full bg-(--viz-series-1)" />
        </figcaption>
      </figure>
    </div>
    <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div
        v-for="r in readouts"
        :key="r.id"
        :data-test="`readout-${r.id}`"
        :data-level="r.level"
        class="rounded-md border border-default px-2 py-1.5"
      >
        <dt class="flex items-center gap-1 text-xs text-muted">
          <UTooltip :text="`${STATUS[r.level].label} (${r.limit})`">
            <UIcon
              :name="STATUS[r.level].icon"
              class="size-3.5"
              :style="{ color: STATUS[r.level].color }"
            />
          </UTooltip>
          {{ r.label }}
          <span class="sr-only">{{ STATUS[r.level].label }}</span>
        </dt>
        <dd class="font-semibold tabular-nums">
          <span class="readout min-w-[6ch]">{{ r.value }}</span>
          <span class="text-xs font-normal text-dimmed">/ {{ r.limit }}</span>
        </dd>
      </div>
    </dl>
  </UCard>
</template>
