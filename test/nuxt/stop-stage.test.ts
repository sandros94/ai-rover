import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { SIGHT_INTERVAL_MS } from '~/composables/useCurrentSight'
import { flushPromises } from '@vue/test-utils'
import { MAP_VIEW_KEY } from '~/composables/useMapView'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopMap from '~/components/map/StopMap.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'

// The scene needs WebGL; what matters here is which view is mounted and what it is handed.
vi.mock('~/components/scene/DiskScene.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'DiskScene',
      props: {
        reveals: { type: Array, default: () => [] },
        sight: { type: Uint8Array, default: undefined },
      },
      setup: (props) => () =>
        vue.h('div', {
          'data-test': 'scene',
          'data-reveals': String(props.reveals.length),
          'data-sight': String(props.sight?.reduce((n, v) => n + v, 0) ?? 'none'),
        }),
    }),
  }
})

function grid(size: number) {
  const heights = new Float32Array(size * size).map((_, k) => (k % size) * 0.1)
  return { heights, width: size, height: size, cellSize: 1 }
}

async function mountStage(view: '2d' | '3d') {
  const wrapper = await mountSuspended(StopStage, {
    props: {
      view,
      terrain: { grid: grid(129), origin: { i: -64, j: -64 } },
      seen: new Uint8Array(129 * 129),
      reveals: [{ vertices: [0, 1] }],
      chunkVertices: 65,
      heightAt: () => 0,
      loading: { loaded: 4, total: 4, error: null },
      center: { x: 0, y: 0 },
      radius: 64,
      rover: { x: 0, y: 0, headingRad: 0 },
    },
  })
  await flushPromises()
  return wrapper
}

/** A host holding the visitor's view choice, as the dashboard and the replay do. */
async function mountChoice() {
  const Host = defineComponent({
    setup() {
      const view = useMapView()
      return () => h('p', { 'data-test': 'choice' }, view.value)
    },
  })
  const wrapper = await mountSuspended(Host)
  await flushPromises()
  return wrapper
}

afterEach(() => localStorage.removeItem(MAP_VIEW_KEY))

describe('StopStage', () => {
  it('draws the 2D map or the scene, with the same reveals, as its view says', async () => {
    const flat = await mountStage('2d')
    expect(flat.find('[data-test=map]').exists()).toBe(true)
    expect(flat.find('[data-test=scene]').exists()).toBe(false)

    const scene = await mountStage('3d')
    expect(scene.find('[data-test=map]').exists()).toBe(false)
    expect(scene.find('[data-test=scene]').attributes('data-reveals')).toBe('1')
  })

  it("hands both views the rover's line of sight over the whole disk, driving or not", async () => {
    const size = 129
    const within = (radius: number) => {
      let n = 0
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++) if (Math.hypot(i - 64, j - 64) <= radius) n++
      return n
    }
    const frame = shallowRef<Float32Array>()
    // An even slope hides nothing.
    const terrain = { grid: grid(size), origin: { i: -64, j: -64 } }
    const seen = new Uint8Array(size * size).fill(1)
    const mount = (view: '2d' | '3d') =>
      mountSuspended(
        defineComponent({
          setup: () => () =>
            h(StopStage, {
              view,
              terrain,
              seen,
              chunkVertices: 65,
              heightAt: () => 0,
              loading: { loaded: 4, total: 4, error: null },
              center: { x: 0, y: 0 },
              radius: 64,
              mastHeight: 2,
              rover: { x: 0, y: 0, headingRad: 0 },
              frame: frame.value,
            }),
        }),
      )
    const flat = await mount('2d')
    await flushPromises()
    const shown = () => flat.findComponent(StopMap).props('sight') as Uint8Array | undefined
    expect(shown()?.reduce((n, v) => n + v, 0)).toBe(within(64))
    frame.value = new Float32Array(19)
    await nextTick()
    expect(shown()?.reduce((n, v) => n + v, 0)).toBe(within(64))

    frame.value = undefined
    const scene = await mount('3d')
    await flushPromises()
    expect(scene.find('[data-test=scene]').attributes('data-sight')).toBe(String(within(64)))
  })

  it('follows a driving rover at most every interval, and a jump at once', async () => {
    const size = 129
    const rover = shallowRef({ x: 0, y: 0, headingRad: 0 })
    // Held across renders, as the pages hold them: a new grid is a new disk.
    const terrain = { grid: grid(size), origin: { i: -64, j: -64 } }
    const seen = new Uint8Array(size * size).fill(1)
    const frame = new Float32Array(19)
    const wrapper = await mountSuspended(
      defineComponent({
        setup: () => () =>
          h(StopStage, {
            view: '2d',
            terrain,
            seen,
            heightAt: () => 0,
            loading: { loaded: 4, total: 4, error: null },
            center: { x: 0, y: 0 },
            radius: 64,
            mastHeight: 2,
            rover: rover.value,
            frame,
          }),
      }),
    )
    await flushPromises()
    const shown = () => wrapper.findComponent(StopMap).props('sight') as Uint8Array
    const first = shown()
    // Driving: a step does not recompute at once, but within the interval.
    rover.value = { x: 1, y: 0, headingRad: 0 }
    await nextTick()
    expect(shown()).toBe(first)
    await new Promise((resolve) => setTimeout(resolve, SIGHT_INTERVAL_MS + 300))
    const stepped = shown()
    expect(stepped).not.toBe(first)
    // The west end of the row through the rover falls just out of reach.
    expect(first[64 * size]).toBe(1)
    expect(stepped[64 * size]).toBe(0)
    // A seek: the sight follows at once.
    rover.value = { x: -10, y: 0, headingRad: 0 }
    await nextTick()
    expect(shown()).not.toBe(stepped)
    expect(shown()[64 * size]).toBe(1)
    expect(shown()[64 * size + size - 1]).toBe(0)
  })

  it('leaves the view switch to the page', async () => {
    const stage = await mountStage('3d')
    expect(stage.find('[data-test=view-2d]').exists()).toBe(false)
  })
})

describe('useMapView', () => {
  it('opens on the scene by default', async () => {
    expect((await mountChoice()).text()).toBe('3d')
  })

  it('opens on the view last chosen in this browser', async () => {
    localStorage.setItem(MAP_VIEW_KEY, '2d')
    expect((await mountChoice()).text()).toBe('2d')
    localStorage.setItem(MAP_VIEW_KEY, 'garbage')
    expect((await mountChoice()).text()).toBe('3d')
  })
})
