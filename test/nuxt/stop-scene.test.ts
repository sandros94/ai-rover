import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, shallowRef } from 'vue'
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
import type { GroundView, GridRect, MapObject } from '#shared/utils/client'
import { gridHeightAt } from '#shared/utils/client'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import { ARM_STOWED } from '#shared/utils/rover'
import { SCENE_QUALITY_KEY } from '~/composables/useSceneQuality'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DiskScene from '~/components/scene/DiskScene.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DeathGhosts from '~/components/scene/DeathGhosts.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import GoalMarkers from '~/components/scene/GoalMarkers.vue'
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
  renderer: { toneMappingExposure: 1, domElement: document.createElement('canvas') },
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

describe('DiskScene over ground still arriving', () => {
  it('stands the flags, a ghost and the resting rover on the ground as drawn once their chunk is in', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Two chunks a side of 65 vertices; the south-west one in first, the north-east one later.
    const size = 129
    const origin = { i: -64, j: -64 }
    const ground = (x: number, y: number) => 3 + 0.05 * x + 0.02 * y
    const heights = new Float32Array(size * size).fill(Number.NaN)
    const place = (rect: GridRect) => {
      for (let j = rect.j0; j < rect.j1; j++) {
        for (let i = rect.i0; i < rect.i1; i++) {
          heights[j * size + i] = ground(i + origin.i, j + origin.j)
        }
      }
    }
    const grid = { heights, width: size, height: size, cellSize: 1 }
    const southWest = { i0: 0, j0: 0, i1: 65, j1: 65 }
    const northEast = { i0: 64, j0: 64, i1: 129, j1: 129 }
    place(southWest)
    const view = shallowRef<GroundView>({ grid, origin, placed: [southWest], complete: false })
    // As the chunk cache answers: whatever is in when asked, with nothing telling it changed.
    const heightAt = (x: number, y: number) => gridHeightAt(heights, { ...grid, origin }, x, y)
    const rest = { x: -10, y: -10, headingRad: 0 }
    const goal = { kind: 'submission', id: 'submission:a', x: 30, y: 25 } as unknown as MapObject
    const ghost = { x: 20, y: 40, id: 'death:a' }
    const end = { x: 45, y: 10 }
    const wrapper = await mountSuspended(
      defineComponent({
        setup: () => () =>
          h(DiskScene, {
            terrain: view.value,
            chunkVertices: 65,
            heightAt,
            rest,
            route: [rest, end],
            stops: [{ ...rest, current: true }],
            deaths: [ghost],
            objects: [goal],
          }),
      }),
    )
    await flushPromises()
    const standing = () => {
      const markers = wrapper.findComponent(GoalMarkers).props()
      return {
        flag: markers.goals![0]!.z,
        destination: markers.destination!.z,
        ghost: wrapper.findComponent(DeathGhosts).props('deaths')[0]!.z,
        rover: wrapper
          .findAllComponents(RoverModel)
          .find((model) => !model.props('ghost'))!
          .props('frame')[KEYFRAME_FIELDS.indexOf('z')] as number,
      }
    }
    const expected = {
      flag: ground(goal.x, goal.y),
      destination: ground(end.x, end.y),
      ghost: ground(ghost.x, ghost.y),
      rover: ground(rest.x, rest.y),
    }
    // Before their chunk, the flags and the ghost stand on no ground; the rover already does.
    const before = standing()
    expect(Math.abs(before.rover - expected.rover)).toBeLessThan(0.01)
    expect(Math.abs(before.flag - expected.flag)).toBeGreaterThan(1)
    expect(Math.abs(before.ghost - expected.ghost)).toBeGreaterThan(1)

    place(northEast)
    view.value = { grid, origin, placed: [southWest, northEast], complete: false }
    await flushPromises()
    const after = standing()
    const within = (key: keyof typeof expected) => Math.abs(after[key] - expected[key]) < 0.01
    expect({
      flag: within('flag'),
      destination: within('destination'),
      ghost: within('ghost'),
      rover: within('rover'),
    }).toEqual({ flag: true, destination: true, ghost: true, rover: true })
    wrapper.unmount()
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
    useSceneQuality().choice.value = { tier: 'high' }
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

  it('renders no shadow map and no caster once shadows are off, without a reload', async () => {
    localStorage.setItem(SCENE_QUALITY_KEY, 'high')
    const stage = await mountScene()
    await flushPromises()
    useSceneQuality().choice.value = { tier: 'high', shadows: 'off' }
    await flushPromises()
    expect(tres.canvas.at(-1)).toMatchObject({ shadows: false })
    expect(stage.findComponent({ name: 'SceneSun' }).props('shadows')).toBe(false)
    expect(stage.findComponent(TerrainChunks).props('casters')).toBeNull()
    expect(stage.findComponent(RoverModel).props('shadows')).toBe(false)
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
      return () => h('p', `${choice.value.tier} ${tier.value}`)
    },
  })

  it('starts on the device default, keeps a choice in this browser, and forgets it on auto', async () => {
    const first = await mountSuspended(Choice)
    const [choice, tier] = first.text().split(' ')
    expect(choice).toBe('auto')
    expect(['high', 'medium', 'low']).toContain(tier)

    useSceneQuality().choice.value = { tier: 'medium', shadows: 'off' }
    expect(JSON.parse(localStorage.getItem(SCENE_QUALITY_KEY)!)).toEqual({
      tier: 'medium',
      shadows: 'off',
    })

    // A new page reads it back.
    clearNuxtState(['scene-quality', 'scene-quality-read'])
    expect((await mountSuspended(Choice)).text()).toBe('medium medium')

    useSceneQuality().choice.value = { tier: 'auto' }
    expect(localStorage.getItem(SCENE_QUALITY_KEY)).toBeNull()
  })

  it('ignores a stored value that is no tier', async () => {
    localStorage.setItem(SCENE_QUALITY_KEY, 'ultra')
    expect((await mountSuspended(Choice)).text().split(' ')[0]).toBe('auto')
  })
})
