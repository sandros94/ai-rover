import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { MAP_VIEW_KEY } from '~/composables/useMapView'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'

// The scene needs WebGL; what matters here is which view is mounted and what it is handed.
vi.mock('~/components/scene/DiskScene.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'DiskScene',
      props: { reveals: { type: Array, default: () => [] } },
      setup: (props) => () =>
        vue.h('div', { 'data-test': 'scene', 'data-reveals': String(props.reveals.length) }),
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
