import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { CustomToneMapping, PCFShadowMap, ShaderChunk, SRGBColorSpace } from 'three'
import { skyLighting, sunPosition } from '#shared/utils/client/scene'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'

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
      },
      setup(props, { slots }) {
        tres.canvas.push(props)
        return () => vue.h('div', { 'data-test': 'canvas' }, slots.default?.())
      },
    }),
    useTres: () => ({ renderer: tres.renderer, camera: vue.computed(() => undefined), scene }),
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
}))

function grid(size: number) {
  const heights = new Float32Array(size * size).map((_, k) => (k % size) * 0.1)
  return { heights, width: size, height: size, cellSize: 1 }
}

describe('StopStage in 3D', () => {
  it('lights the scene with the sun of its time, under AgX with soft shadows', async () => {
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

    expect(tres.canvas.at(-1)).toMatchObject({
      toneMapping: CustomToneMapping,
      outputColorSpace: SRGBColorSpace,
      shadows: true,
      shadowMapType: PCFShadowMap,
    })
    // The scene filled three's custom tone mapping slot with AgX before anything compiled.
    expect(ShaderChunk.tonemapping_pars_fragment).toContain('agxLook( color )')

    // The first frame takes the automatic exposure at once.
    for (const callback of tres.beforeRender) callback({ delta: 1 / 60 })
    expect(tres.renderer.toneMappingExposure).toBeCloseTo(
      skyLighting(sunPosition(solFraction).elevationDeg).exposure,
      9,
    )
  })
})
