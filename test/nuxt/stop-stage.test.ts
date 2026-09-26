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

/** A stage whose `view` model lives in the host, as the map and the replay hold it. */
async function mountStage(initial: '2d' | '3d' = '2d') {
  const Host = defineComponent({
    setup() {
      const view = useMapView()
      if (initial === '3d') view.value = '3d'
      return () =>
        h(StopStage, {
          'view': view.value,
          'onUpdate:view': (next: '2d' | '3d') => (view.value = next),
          'terrain': { grid: grid(129), origin: { i: -64, j: -64 } },
          'seen': new Uint8Array(129 * 129),
          'reveals': [{ vertices: [0, 1] }],
          'chunkVertices': 65,
          'heightAt': () => 0,
          'loading': { loaded: 4, total: 4, error: null },
          'center': { x: 0, y: 0 },
          'radius': 64,
          'rover': { x: 0, y: 0, headingRad: 0 },
        })
    },
  })
  const wrapper = await mountSuspended(Host)
  await flushPromises()
  return wrapper
}

afterEach(() => localStorage.removeItem(MAP_VIEW_KEY))

describe('StopStage', () => {
  it('opens on the 2D map and switches to the scene with the same reveals', async () => {
    const wrapper = await mountStage()
    expect(wrapper.find('[data-test=map]').exists()).toBe(true)
    expect(wrapper.find('[data-test=scene]').exists()).toBe(false)

    await wrapper.find('[data-test=view-3d]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test=map]').exists()).toBe(false)
    expect(wrapper.find('[data-test=scene]').attributes('data-reveals')).toBe('1')

    await wrapper.find('[data-test=view-2d]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test=map]').exists()).toBe(true)
  })

  it('remembers the choice in browser storage and opens on it next time', async () => {
    const first = await mountStage()
    await first.find('[data-test=view-3d]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem(MAP_VIEW_KEY)).toBe('3d')
    first.unmount()

    const again = await mountStage()
    expect(again.find('[data-test=scene]').exists()).toBe(true)
  })
})
