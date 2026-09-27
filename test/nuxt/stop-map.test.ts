import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { createDiskGround, expandRect, groundView } from '#shared/utils/client'
import { generateChunk } from '#shared/utils/terrain'
import { journeyFixture } from '../unit/client/helpers'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopMap from '~/components/map/StopMap.vue'

/** The map lays itself out in a 400 × 400 px box whose corner sits at client (10, 20). */
const BOX = { left: 10, top: 20, width: 400, height: 400 }

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: BOX.left,
    y: BOX.top,
    right: BOX.left + BOX.width,
    bottom: BOX.top + BOX.height,
    toJSON: () => ({}),
  })
})
afterAll(() => vi.restoreAllMocks())

function grid(size: number) {
  const heights = new Float32Array(size * size).map((_, k) => (k % size) * 0.1)
  return { heights, width: size, height: size, cellSize: 1 }
}

async function mountMap() {
  const wrapper = await mountSuspended(StopMap, {
    props: {
      terrain: { grid: grid(121), origin: { i: -60, j: -60 } },
      center: { x: 0, y: 0 },
      radius: 60,
      anchor: { x: 0, y: 0 },
      ring: { minM: 20, maxM: 50 },
      rover: { x: 0, y: 0, headingRad: 0 },
    },
  })
  await nextTick()
  return wrapper
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    clientX: BOX.left + x,
    clientY: BOX.top + y,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    ...init,
  })
}

describe('StopMap', () => {
  it('mounts with the overlay once laid out', async () => {
    const wrapper = await mountMap()
    expect(wrapper.find('[data-test=map]').exists()).toBe(true)
    expect(wrapper.find('svg').attributes('viewBox')).toBe('0 0 400 400')
  })

  it('emits pick at the world point under a tap, north up', async () => {
    const wrapper = await mountMap()
    const map = wrapper.find('[data-test=map]').element
    // The 120 m disk box fits 384 px (8 px padding each side): 3.2 px per metre.
    map.dispatchEvent(pointer('pointerdown', 200, 200))
    map.dispatchEvent(pointer('pointerup', 200, 200))
    map.dispatchEvent(pointer('pointerdown', 264, 136))
    map.dispatchEvent(pointer('pointerup', 264, 136))
    const picks = wrapper.emitted('pick') as [{ x: number; y: number }][]
    expect(picks).toHaveLength(2)
    expect(picks[0]![0].x).toBeCloseTo(0, 9)
    expect(picks[0]![0].y).toBeCloseTo(0, 9)
    expect(picks[1]![0].x).toBeCloseTo(20, 9)
    expect(picks[1]![0].y).toBeCloseTo(20, 9)
  })

  it('pans on a drag instead of picking', async () => {
    const wrapper = await mountMap()
    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointerdown', 200, 200))
    map.dispatchEvent(pointer('pointermove', 240, 200))
    map.dispatchEvent(pointer('pointerup', 240, 200))
    expect(wrapper.emitted('pick')).toBeUndefined()
    // After a 40 px drag east, the disk centre sits under the pointer.
    map.dispatchEvent(pointer('pointerdown', 240, 200))
    map.dispatchEvent(pointer('pointerup', 240, 200))
    const picks = wrapper.emitted('pick') as [{ x: number; y: number }][]
    const point = picks[0]![0]
    expect(point.x).toBeCloseTo(0, 9)
    expect(point.y).toBeCloseTo(0, 9)
  })

  it('emits hover for a mouse moving without a button, and null on leaving', async () => {
    const wrapper = await mountMap()
    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointermove', 200, 232, { pointerType: 'mouse' }))
    map.dispatchEvent(pointer('pointerleave', 0, 0, { pointerType: 'mouse' }))
    const hovers = wrapper.emitted('hover') as [{ x: number; y: number } | null][]
    expect(hovers[0]![0]!.x).toBeCloseTo(0, 9)
    expect(hovers[0]![0]!.y).toBeCloseTo(-10, 9)
    expect(hovers[1]![0]).toBeNull()
  })
})

describe('StopMap over ground still arriving', () => {
  /** Every `putImageData` on a relief canvas: the image and its dirty rectangle. */
  const puts: { data: ImageData; dirty: number[] }[] = []

  beforeAll(() => {
    if (typeof ImageData === 'undefined') {
      vi.stubGlobal(
        'ImageData',
        class {
          readonly data: Uint8ClampedArray
          constructor(
            readonly width: number,
            readonly height: number,
          ) {
            this.data = new Uint8ClampedArray(width * height * 4)
          }
        },
      )
    }
    // No canvas in the test DOM: a context that records the relief's writes and ignores the rest.
    const context = new Proxy(
      {
        putImageData: (data: ImageData, _x: number, _y: number, ...dirty: number[]) =>
          puts.push({ data, dirty }),
      },
      { get: (target, prop) => Reflect.get(target, prop) ?? (() => {}) },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
  })
  afterAll(() => vi.unstubAllGlobals())

  it('paints the chunks in, then only the rectangle of each arrival', async () => {
    const { stopManifest, world } = journeyFixture()
    const ground = createDiskGround(stopManifest)
    const [southWest, southEast, northEast] = [
      [-1, -1],
      [0, -1],
      [0, 0],
    ].map(([cx, cy]) => generateChunk(world, { cx: cx!, cy: cy! }))
    ground.place(southWest!)
    ground.place(northEast!)
    puts.length = 0
    // Rendered by a parent, as the stage does: the views keep their identity on the way in.
    const view = shallowRef(groundView(ground, stopManifest.heightRange))
    await mountSuspended(
      defineComponent({
        setup: () => () =>
          h(StopMap, {
            terrain: view.value,
            center: { x: 0, y: 0 },
            radius: 60,
            rover: { x: 0, y: 0, headingRad: 0 },
          }),
      }),
    )
    await nextTick()
    const { width, height } = ground.grid
    const dirty = (rect: { i0: number; j0: number; i1: number; j1: number }) => {
      // The chunk's vertices and the one vertex around it, clamped to the grid.
      const { i0, j0, i1, j1 } = expandRect(rect, 1, ground.grid)
      return [i0, height - j1, i1 - i0, j1 - j0]
    }
    // Cleared once, then only the two chunks that are in.
    expect(puts.map((put) => put.dirty)).toEqual([
      [],
      dirty(ground.placed[0]!),
      dirty(ground.placed[1]!),
    ])
    const { data } = puts[0]!
    const alpha = (i: number, j: number) => data.data[((height - 1 - j) * width + i) * 4 + 3]
    expect(alpha(10, 10)).toBe(255)
    expect(alpha(100, 100)).toBe(255)
    expect(alpha(100, 10)).toBe(0)
    expect(alpha(10, 100)).toBe(0)

    const arrived = ground.place(southEast!)!
    view.value = groundView(ground, stopManifest.heightRange)
    await nextTick()
    expect(puts.slice(3).map((put) => put.dirty)).toEqual([dirty(arrived)])
    expect(alpha(100, 10)).toBe(255)
    expect(alpha(10, 100)).toBe(0)
  })
})
