import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { CustomToneMapping, PCFShadowMap, ShaderChunk, SRGBColorSpace } from 'three'
import {
  ARM_NIGHT,
  ARM_SEQUENCE_S,
  armPoseAlong,
  chunksFromGrid,
  flatFrame,
  qualityFor,
  skyLighting,
  sunCrossings,
  sunPosition,
} from '#shared/utils/client/scene'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments'
import { ARM_STOWED } from '#shared/utils/rover'
import { SCENE_QUALITY_KEY } from '~/composables/useSceneQuality'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopScene from '~/components/scene/StopScene.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import TerrainChunks from '~/components/scene/TerrainChunks.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverModel from '~/components/scene/RoverModel.vue'

/**
 * There is no WebGL here: the canvas is a stand-in that renders the scene's components and keeps
 * the renderer settings it is given, and the render loop runs when the test says.
 */
const tres = vi.hoisted(() => ({
  canvas: [] as Record<string, unknown>[],
  beforeRender: [] as ((context: { delta: number }) => void)[],
  renderer: { toneMappingExposure: 1 },
}))

vi.mock('@tresjs/core', async () => {
  const vue = await import('vue')
  const { Scene } = await import('three')
  const scene = vue.shallowRef(new Scene())
  return {
    TresCanvas: vue.defineComponent({
      name: 'TresCanvas',
      props: {
        toneMapping: { type: Number, default: undefined },
        outputColorSpace: { type: String, default: undefined },
        shadows: { type: Boolean, default: undefined },
        shadowMapType: { type: Number, default: undefined },
        dpr: { type: Array, default: undefined },
        renderMode: { type: String, default: undefined },
      },
      setup(props, { slots }) {
        tres.canvas.push(props)
        return () => vue.h('div', { 'data-test': 'canvas' }, slots.default?.())
      },
    }),
    useTres: () => ({
      renderer: tres.renderer,
      camera: vue.computed(() => undefined),
      scene,
      invalidate: () => {},
    }),
    useLoop: () => ({
      onBeforeRender: (callback: (context: { delta: number }) => void) => {
        tres.beforeRender.push(callback)
      },
    }),
  }
})
// Orbit controls need a real camera and canvas.
vi.mock('~/components/scene/FollowCamera.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name: 'FollowCamera', render: () => null }) }
})
vi.mock('~/utils/rover-model', () => ({
  loadRoverModel: () => Promise.reject(new Error('no model in tests')),
  applyEnvironment: () => {},
}))
// Prefiltering the sky for reflections needs a WebGL renderer.
vi.mock('~/components/scene/SceneEnvironment.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name: 'SceneEnvironment', render: () => null }) }
})

/** The scene on a one-chunk disk, the rover resting in its middle. */
function mountScene() {
  return mountSuspended(StopScene, {
    props: {
      frame: flatFrame({ x: 32, y: 32, z: 0, headingRad: 0 }),
      chunks: chunksFromGrid(grid(65), { i: 0, j: 0 }, 65),
      heightRange: { min: 0, max: 6.4 },
      heightAt: () => 0,
    },
  })
}

function grid(size: number) {
  const heights = new Float32Array(size * size).map((_, k) => (k % size) * 0.1)
  return { heights, width: size, height: size, cellSize: 1 }
}

describe('StopStage in 3D', () => {
  it('lights the scene with the sun of its time and hazes it in its sky, under AgX with soft shadows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const solFraction = 0.3
    const stage = await mountSuspended(StopStage, {
      props: {
        view: '3d',
        terrain: { grid: grid(65), origin: { i: 0, j: 0 } },
        seen: new Uint8Array(65 * 65).fill(1),
        chunkVertices: 65,
        heightAt: () => 0,
        loading: { loaded: 1, total: 1, error: null },
        center: { x: 32, y: 32 },
        radius: 32,
        rover: { x: 32, y: 32, headingRad: 0 },
        solFraction,
      },
    })
    await flushPromises()

    expect(stage.find('[data-test=canvas]').exists()).toBe(true)
    const sun = stage.findComponent({ name: 'SceneSun' })
    expect(sun.exists()).toBe(true)
    expect(sun.props('direction')).toEqual(sunPosition(solFraction).direction)
    // Haze, sky background and unseen ground are the sky's horizon, whatever the colour mode.
    const horizon = skyLighting(sunPosition(solFraction).elevationDeg).horizon
    expect(stage.findComponent({ name: 'SceneAtmosphere' }).props('color')).toBe(horizon)

    expect(tres.canvas.at(-1)).toMatchObject({
      toneMapping: CustomToneMapping,
      outputColorSpace: SRGBColorSpace,
      shadows: true,
      shadowMapType: PCFShadowMap,
    })
    // The scene filled three's custom tone mapping slot with AgX before anything compiled.
    expect(ShaderChunk.tonemapping_pars_fragment).toContain('agxLook( color )')

    // No rover model loads here: the scene draws without one, and says so.
    expect(stage.find('[data-test=rover-unavailable]').text()).toBe('Rover model unavailable')

    // The first frame takes the automatic exposure at once.
    for (const callback of tres.beforeRender) callback({ delta: 1 / 60 })
    expect(tres.renderer.toneMappingExposure).toBeCloseTo(
      skyLighting(sunPosition(solFraction).elevationDeg).exposure,
      9,
    )
  })

  it('unstows the arm into its night pose once the sun is down, and stows it by day', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const armAt = async (solFraction: number) => {
      const stage = await mountSuspended(StopStage, {
        props: {
          view: '3d',
          terrain: { grid: grid(65), origin: { i: 0, j: 0 } },
          seen: new Uint8Array(65 * 65).fill(1),
          chunkVertices: 65,
          heightAt: () => 0,
          loading: { loaded: 1, total: 1, error: null },
          center: { x: 32, y: 32 },
          radius: 32,
          rover: { x: 32, y: 32, headingRad: 0 },
          solFraction,
        },
      })
      await flushPromises()
      return stage.findComponent(RoverModel).props('joints') as Record<string, number>
    }
    const { set } = sunCrossings()
    expect(await armAt(0.4)).toMatchObject(ARM_STOWED)
    const night = await armAt(set + (ARM_SEQUENCE_S + 1) / MARS_SOL_SECONDS)
    for (const [node, value] of Object.entries(ARM_NIGHT)) expect(night[node]).toBeCloseTo(value, 9)
    // Halfway through the unstow, at the sequence's halfway point.
    const half = await armAt(set + ARM_SEQUENCE_S / 2 / MARS_SOL_SECONDS)
    const along = armPoseAlong(ARM_SEQUENCE_S / 2)
    for (const [node, value] of Object.entries(along)) expect(half[node]).toBeCloseTo(value, 3)
  })
})

describe('StopScene at a quality tier', () => {
  beforeEach(() => {
    localStorage.removeItem(SCENE_QUALITY_KEY)
    clearNuxtState(['scene-quality', 'scene-quality-read'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('draws on demand, and sets the pixel ratio cap, shadows, map size, casters and rover detail of the tier stored', async () => {
    localStorage.setItem(SCENE_QUALITY_KEY, 'low')
    const stage = await mountScene()
    await flushPromises()
    const low = qualityFor('low')
    expect(tres.canvas.at(-1)).toMatchObject({
      renderMode: 'on-demand',
      dpr: [1, low.maxDpr],
      shadows: true,
    })
    expect(stage.findComponent({ name: 'SceneSun' }).props()).toMatchObject({
      shadows: true,
      shadowMapSize: low.shadowMapSize,
    })
    // The low tier's ground only receives: the rover alone casts.
    expect(stage.findComponent(TerrainChunks).props('casters')).toBeNull()
    expect(stage.findComponent(RoverModel).props('lodDistanceM')).toBe(low.roverLodM)
  })

  it('applies a new tier at once, the ground casting around the camera target', async () => {
    localStorage.setItem(SCENE_QUALITY_KEY, 'low')
    const stage = await mountScene()
    await flushPromises()
    useSceneQuality().choice.value = 'high'
    await flushPromises()
    const high = qualityFor('high')
    expect(tres.canvas.at(-1)).toMatchObject({ dpr: [1, high.maxDpr], shadows: true })
    expect(stage.findComponent({ name: 'SceneSun' }).props('shadowMapSize')).toBe(
      high.shadowMapSize,
    )
    // The rover stands at (32, 32); the camera looks at its middle.
    expect(stage.findComponent(TerrainChunks).props('casters')).toEqual({
      x: 32,
      y: 32,
      rangeM: high.casterRangeM,
    })
    expect(stage.findComponent(RoverModel).props('lodDistanceM')).toBe(high.roverLodM)
  })
})

describe('useSceneQuality', () => {
  beforeEach(() => {
    localStorage.removeItem(SCENE_QUALITY_KEY)
    clearNuxtState(['scene-quality', 'scene-quality-read'])
  })

  const Choice = defineComponent({
    setup() {
      const { choice, tier } = useSceneQuality()
      return () => h('p', `${choice.value} ${tier.value}`)
    },
  })

  it('starts on the device default, keeps a choice in this browser, and forgets it on auto', async () => {
    const first = await mountSuspended(Choice)
    const [choice, tier] = first.text().split(' ')
    expect(choice).toBe('auto')
    expect(['high', 'medium', 'low']).toContain(tier)

    useSceneQuality().choice.value = 'medium'
    expect(localStorage.getItem(SCENE_QUALITY_KEY)).toBe('medium')

    // A new page reads it back.
    clearNuxtState(['scene-quality', 'scene-quality-read'])
    expect((await mountSuspended(Choice)).text()).toBe('medium medium')

    useSceneQuality().choice.value = 'auto'
    expect(localStorage.getItem(SCENE_QUALITY_KEY)).toBeNull()
  })

  it('ignores a stored value that is no tier', async () => {
    localStorage.setItem(SCENE_QUALITY_KEY, 'ultra')
    expect((await mountSuspended(Choice)).text().split(' ')[0]).toBe('auto')
  })
})
