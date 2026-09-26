<script setup lang="ts">
import { computed } from 'vue'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import { DEFAULT_ROVER_GEOMETRY as G } from '#shared/utils/rover'
import { PLAYGROUND_PROPS } from '../../playground/registry'

const props = defineProps(PLAYGROUND_PROPS)

type Field = (typeof KEYFRAME_FIELDS)[number]
const value = (name: Field): number => props.frame[KEYFRAME_FIELDS.indexOf(name)]!
const DEG = 180 / Math.PI

/** Pitch and roll of the world-from-body quaternion `Rz(heading) · Ry(pitch) · Rx(roll)`. */
const attitude = computed(() => {
  const [x, y, z, w] = [value('qx'), value('qy'), value('qz'), value('qw')]
  return {
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
  }
})

type Point = [number, number]

/** Left-side linkage in body x-z, then pitched: positive pitch lowers the nose. */
const linkage = computed(() => {
  const rocker = value('rockerL')
  const bogie = value('bogieL')
  const { rockerPivot: d, bogiePivot: b, wheelRadius: r } = G
  const turn = ([px, pz]: Point, [cx, cz]: Point, a: number): Point => [
    cx + (px - cx) * Math.cos(a) - (pz - cz) * Math.sin(a),
    cz + (px - cx) * Math.sin(a) + (pz - cz) * Math.cos(a),
  ]
  const onRocker = (p: Point): Point => turn(p, [d.x, d.z], rocker)
  const onBogie = (p: Point): Point => onRocker(turn(p, [b.x, b.z], bogie))
  const p = attitude.value.pitch
  const pitched = ([x, z]: Point): Point => [
    x * Math.cos(p) + z * Math.sin(p),
    -x * Math.sin(p) + z * Math.cos(p),
  ]
  return {
    front: pitched(onRocker([G.frontWheel.x, r])),
    middle: pitched(onBogie([G.middleWheel.x, r])),
    rear: pitched(onBogie([G.rearWheel.x, r])),
    rockerPivot: pitched([d.x, d.z]),
    bogiePivot: pitched(onRocker([b.x, b.z])),
    body: [
      [-0.95, 0.9],
      [1.05, 0.9],
      [1.05, 1.35],
      [-0.95, 1.35],
    ].map((q) => pitched(q as Point)),
  }
})

/** Body metres to SVG units, z up. */
const S = 100
const svg = ([x, z]: Point): string => `${(x * S).toFixed(1)},${(-z * S).toFixed(1)}`
const line = (...points: Point[]): string => points.map(svg).join(' ')

const readout = computed(() => [
  ['t', `${value('t').toFixed(1)} s`],
  ['speed', `${(value('speed') * 100).toFixed(1)} cm/s`],
  ['pitch', `${(attitude.value.pitch * DEG).toFixed(2)}°`],
  ['roll', `${(attitude.value.roll * DEG).toFixed(2)}°`],
  [
    'rocker L / R',
    `${(value('rockerL') * DEG).toFixed(2)}° / ${(value('rockerR') * DEG).toFixed(2)}°`,
  ],
  [
    'bogie L / R',
    `${(value('bogieL') * DEG).toFixed(2)}° / ${(value('bogieR') * DEG).toFixed(2)}°`,
  ],
])
</script>

<template>
  <div class="flex flex-wrap items-center gap-8">
    <svg
      viewBox="-160 -210 320 240"
      class="w-full max-w-xl"
      role="img"
      aria-label="Rover side view, left"
    >
      <line
        x1="-160"
        x2="160"
        y1="0"
        y2="0"
        class="stroke-(--ui-border-accented)"
        stroke-dasharray="4 4"
      />
      <polygon
        :points="line(...linkage.body)"
        class="fill-(--ui-bg-elevated) stroke-(--ui-border-accented)"
      />
      <polyline
        :points="line(linkage.front, linkage.rockerPivot, linkage.bogiePivot)"
        class="fill-none stroke-(--ui-primary)"
        stroke-width="5"
      />
      <polyline
        :points="line(linkage.middle, linkage.bogiePivot, linkage.rear)"
        class="fill-none stroke-(--ui-secondary)"
        stroke-width="4"
      />
      <circle
        v-for="(wheel, k) in [linkage.front, linkage.middle, linkage.rear]"
        :key="k"
        :cx="wheel[0] * S"
        :cy="-wheel[1] * S"
        :r="G.wheelRadius * S"
        class="fill-none stroke-(--ui-text-highlighted)"
        stroke-width="3"
      />
      <g :transform="`translate(0 -185) rotate(${(-attitude.roll * DEG).toFixed(2)})`">
        <line x1="-25" x2="25" y1="0" y2="0" class="stroke-(--ui-primary)" stroke-width="3" />
        <text y="18" text-anchor="middle" class="fill-(--ui-text-muted) text-[10px]">roll</text>
      </g>
    </svg>
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-sm">
      <template v-for="[label, text] in readout" :key="label">
        <dt class="text-muted">{{ label }}</dt>
        <dd>{{ text }}</dd>
      </template>
    </dl>
  </div>
</template>
