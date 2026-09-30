<script lang="ts">
import { installAgXLook } from '#shared/utils/client/scene/tonemap'

// Before any material of the scene compiles: three builds every shader from the chunk.
if (import.meta.client) installAgXLook()
</script>

<script setup lang="ts">
import type { TresContext } from '@tresjs/core'
import { TresCanvas } from '@tresjs/core'
import type { Texture, ToneMapping, WebGLRenderer } from 'three'
import { CustomToneMapping, GridHelper, PCFShadowMap, SRGBColorSpace } from 'three'
import type { DrivenPoint, GridRect } from '#shared/utils/client'
import type { ChunkFog, TerrainChunk } from '#shared/utils/client/scene'
import {
  armPoseAt,
  framePacer,
  framePlacement,
  fullModelLedger,
  LOD_FAR_M,
  routeApproach,
  routeDestination,
  SCENE_COLORS,
  skyLighting,
  sunPosition,
  turretLampLevel,
} from '#shared/utils/client/scene'
import type { RoverModelStatus } from '~/utils/rover-model'
import DeathGhosts from './DeathGhosts.vue'
import FollowCamera from './FollowCamera.vue'
import GoalMarkers from './GoalMarkers.vue'
import RouteLine from './RouteLine.vue'
import RoverModel from './RoverModel.vue'
import type { Pickable } from './ScenePicker.vue'
import ScenePicker from './ScenePicker.vue'
import SceneAtmosphere from './SceneAtmosphere.vue'
import SceneEnvironment from './SceneEnvironment.vue'
import SceneSky from './SceneSky.vue'
import SceneSun from './SceneSun.vue'
import TerrainChunks from './TerrainChunks.vue'
import TrailLayer from './TrailLayer.vue'

const props = withDefaults(
  defineProps<{
    /** The 23 keyframe values at the playback time. */
    frame: Float32Array
    /** Whether the rover is drawn at `frame`; the camera frames it either way. */
    roverShown?: boolean
    /** The stop disk's chunks; without any, the rover stands on a flat grid at its own height. */
    chunks?: { chunk: TerrainChunk }[]
    /** Height span of the disk for the colour ramp; required with `chunks`. */
    heightRange?: { min: number; max: number }
    heightAt?: (x: number, y: number) => number | undefined
    /** Height of the ground as drawn, fog included, for the route; by default `heightAt`. */
    drawnHeightAt?: (x: number, y: number) => number | undefined
    /** The stops shown, the one the rover stands at or left from `current`. */
    stops?: { x: number; y: number; current?: boolean }[]
    /** The path driven, drawn up to `t`. */
    driven?: DrivenPoint[]
    /** Sim seconds, for the path driven so far. */
    t?: number
    route?: { x: number; y: number }[]
    deaths?: { x: number; y: number; z: number; headingRad: number; id?: string }[]
    /** Radius of the red circle around each death, metres. */
    deathRadiusM?: number
    /** The stop disk's fog over `chunks`; without it every chunk shows its true ground. */
    fog?: ChunkFog & { rects?: GridRect[] }
    /** What of the disk the rover has in sight now, laid out as the fog; see `TerrainChunks`. */
    sight?: Uint8Array
    /** The stop's survey: ground beyond it is not drawn, and a thin ring marks its edge. */
    survey?: { center: { x: number; y: number }; radius: number }
    /** The open round's goals, on the ground, flagged. */
    goals?: readonly { id: string; x: number; y: number; z: number }[]
    /** What the pointer can inspect; without any, nothing is picked. */
    pickables?: readonly Pickable[]
    /** The focused object's id, and where the camera looks while it is focused (else the rover). */
    focusedId?: string | null
    focusTarget?: { x: number; y: number; z: number }
    /** Changes with every focus, so the camera eases to the new target. */
    focusKey?: number
    /** Time of the sol, 0 and 1 midnight, 0.5 noon: sets the sun, the sky and the exposure. */
    solFraction?: number
    /** Exposure offset in stops over the automatic exposure. */
    exposureBias?: number
    /** three's tone mapping; another than the scene's AgX look only to compare against it. */
    toneMapping?: ToneMapping
  }>(),
  {
    chunks: () => [],
    heightRange: () => ({ min: 0, max: 1 }),
    roverShown: true,
    heightAt: undefined,
    drawnHeightAt: undefined,
    stops: () => [],
    driven: () => [],
    t: 0,
    route: () => [],
    deaths: () => [],
    deathRadiusM: undefined,
    fog: undefined,
    sight: undefined,
    survey: undefined,
    goals: () => [],
    pickables: () => [],
    focusedId: null,
    focusTarget: undefined,
    focusKey: 0,
    solFraction: 0.4,
    exposureBias: 0,
    toneMapping: CustomToneMapping,
  },
)

const emit = defineEmits<{
  /** What the rover is drawn as changed; see `RoverModelStatus`. */
  roverStatus: [status: RoverModelStatus]
  /** The mouse is over an object, or none. */
  hover: [id: string | null, client: { x: number; y: number }]
  /** A tap or click on an object, or on none. */
  tap: [id: string | null, pointerType: string, client: { x: number; y: number }]
}>()

/** The rover and a focused ghost: never more full rover models than that in the scene. */
const ledger = fullModelLedger()

/** Points of the survey's edge, a closed polyline fine enough to read as a circle. */
const SURVEY_RING_POINTS = 360
const surveyRing = computed(() => {
  const survey = props.survey
  if (!survey) return []
  const { center, radius } = survey
  return Array.from({ length: SURVEY_RING_POINTS + 1 }, (_, k) => {
    const a = (2 * Math.PI * k) / SURVEY_RING_POINTS
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }
  })
})

const rover = computed(() => framePlacement(props.frame).position)
const focus = computed(() => ({ x: rover.value.x, y: rover.value.y }))
/** Camera target: the body's middle rather than its ground-level origin, or the focused object. */
const target = computed(() => props.focusTarget ?? { ...rover.value, z: rover.value.z + 1 })

/** The route's destination, flagged on the ground as drawn until a stop stands there. */
const destination = computed(() => {
  const end = routeDestination(props.route, props.stops)
  if (!end) return null
  const z = (props.drawnHeightAt ?? props.heightAt)?.(end.x, end.y) ?? 0
  return { ...end, z, approach: routeApproach(props.route) }
})
/** The open round's goals were picked around the current stop. */
const currentStop = computed(() => props.stops.find((stop) => stop.current))

/** The sun at the scene's time, and the light, sky and exposure that go with it. */
const sun = computed(() => sunPosition(props.solFraction))
const lighting = computed(() => skyLighting(sun.value.elevationDeg))
/** The sky as the rover's metals and glass reflect it. */
const environment = shallowRef<Texture | null>(null)
const lamp = computed(() => turretLampLevel(sun.value.elevationDeg))
/** After sunset the arm unstows to raise the lamp over the front deck, and stows again after sunrise. */
const armJoints = computed(() => armPoseAt(props.solFraction))
/**
 * Haze, sky at the horizon and unseen ground in one colour, the sky's horizon at the sun's
 * elevation whatever the page's colour mode, so what is too far to make out and what has not been
 * seen look alike. Full detail reaches `LOD_FAR_M`; the fog closes in past it.
 */
const atmosphere = computed(() => lighting.value.horizon)
const HAZE = { near: LOD_FAR_M, far: 4 * LOD_FAR_M }
/** three dropped `PCFSoftShadowMap`; PCF blurs by each light's `shadow.radius` instead. */
const SHADOW_MAP = PCFShadowMap

/** Ground for a scene without terrain: a 1 m grid in the rover's ground plane. */
const plane = new GridHelper(40, 40, '#a8a29e', '#57534e')
plane.rotation.x = Math.PI / 2
watchEffect(() => plane.position.set(rover.value.x, rover.value.y, rover.value.z))
onBeforeUnmount(() => plane.dispose())

/** The viewer's quality tier: shadows, pixel ratio, frame cap and the rover's detail. */
const { quality } = useSceneQuality()
const shadowCasters = computed(() =>
  quality.value.shadows === 'full'
    ? { x: target.value.x, y: target.value.y, rangeM: quality.value.casterRangeM }
    : null,
)

/**
 * The scene is drawn on demand: when something in it changed (a prop, the camera, a model or
 * the exposure settling, each asking through Tres' `invalidate`), at most `frameCap` times a
 * second, or at the display's rate while the view is handled.
 */
const pacer = framePacer(() => quality.value.frameCap)
let context: TresContext | undefined
const handled = () => pacer.interact(performance.now())
const INPUTS = ['pointerdown', 'pointermove', 'wheel'] as const

/** In development, per-pass GPU times for the playground's readout. */
const passTiming = import.meta.dev ? useScenePassTiming() : undefined
let untime: (() => void) | undefined

function onReady(ready: TresContext): void {
  context = ready
  const renderer = ready.renderer.instance as WebGLRenderer
  ready.renderer.replaceRenderFunction((notify) => {
    const camera = ready.camera.activeCamera.value
    const now = performance.now()
    // Not due yet: Tres keeps the frame asked for and offers it again next display frame.
    if (!camera || !pacer.due(now)) return
    renderer.render(ready.scene.value, camera)
    pacer.drawn(now)
    notify()
  })
  for (const type of INPUTS) renderer.domElement.addEventListener(type, handled, { passive: true })
  if (import.meta.dev) {
    untime = timeScenePasses(renderer, (timing) => {
      passTiming!.value = timing
    })
  }
}
watch(
  () => [{ ...props }, quality.value],
  () => context?.renderer.invalidate(),
)
// The camera eases onto a new focus: drawn at the display's rate like any handling.
watch(() => props.focusKey, handled)
onBeforeUnmount(() => {
  untime?.()
  const canvas = context?.renderer.instance.domElement
  for (const type of INPUTS) canvas?.removeEventListener(type, handled)
})
</script>

<template>
  <TresCanvas
    :dpr="[1, quality.maxDpr]"
    render-mode="on-demand"
    power-preference="high-performance"
    :tone-mapping="toneMapping"
    :output-color-space="SRGBColorSpace"
    :shadows="quality.shadows !== 'off'"
    :shadow-map-type="SHADOW_MAP"
    :clear-color="atmosphere"
    @ready="onReady"
  >
    <SceneAtmosphere :color="atmosphere" :near="HAZE.near" :far="HAZE.far" />
    <SceneSky :direction="sun.direction" :lighting="lighting" />
    <SceneEnvironment
      :direction="sun.direction"
      :lighting="lighting"
      @change="environment = $event"
    />
    <SceneSun
      :direction="sun.direction"
      :lighting="lighting"
      :target="target"
      :exposure-bias="exposureBias"
      :shadows="quality.shadows !== 'off'"
      :shadow-map-size="quality.shadowMapSize"
    />
    <FollowCamera
      :target="target"
      :target-key="focusKey"
      :offset="chunks.length > 0 ? undefined : [-3.5, -3.5, 2]"
    />
    <TerrainChunks
      v-if="chunks.length > 0"
      :chunks="chunks"
      :height-range="heightRange"
      :focus="focus"
      :height-at="heightAt"
      :fog="fog"
      :sight="sight"
      :survey="survey"
      :casters="shadowCasters"
    />
    <primitive v-else :object="plane" />
    <RouteLine
      v-if="chunks.length > 0 && surveyRing.length > 0"
      :route="surveyRing"
      :height-at="drawnHeightAt ?? heightAt"
      :color="SCENE_COLORS.survey"
    />
    <RouteLine v-if="route.length > 1" :route="route" :height-at="drawnHeightAt ?? heightAt" />
    <TrailLayer :stops="stops" :driven="driven" :t="t" :height-at="heightAt" />
    <DeathGhosts
      v-if="deaths.length > 0"
      :deaths="deaths"
      :height-at="heightAt"
      :radius-m="deathRadiusM"
      :focused-id="focusedId"
      :ledger="ledger"
    />
    <GoalMarkers
      v-if="goals.length > 0 || destination"
      :goals="goals"
      :focused-id="focusedId"
      :from="currentStop"
      :destination="destination"
    />
    <TresGroup :visible="roverShown">
      <RoverModel
        :frame="frame"
        :ledger="ledger"
        :lamp="lamp"
        :joints="armJoints"
        :environment="environment"
        :lod-distance-m="quality.roverLodM"
        @status="emit('roverStatus', $event)"
      />
    </TresGroup>
    <ScenePicker
      v-if="pickables.length > 0"
      :pickables="pickables"
      :rover="rover"
      @hover="(id, client) => emit('hover', id, client)"
      @tap="(id, type, client) => emit('tap', id, type, client)"
    />
  </TresCanvas>
</template>
