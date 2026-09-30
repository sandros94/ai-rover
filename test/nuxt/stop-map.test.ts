import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import {
  createDiskGround,
  expandRect,
  FOG_FILL,
  groundView,
  revealTimes,
} from '#shared/utils/client'
import { groundRgb, hillshadeAt, reliefLight } from '#shared/utils/client/scene'
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

/** The fog over `seen` with nothing fading, as `useRevealFade` gives it first. */
function settled(seen: Uint8Array) {
  return { fog: { seen, revealedAt: revealTimes(seen), now: 0 } }
}

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

  it("draws the 3D camera's footprint under everything else, and none without one", async () => {
    const wrapper = await mountMap()
    expect(wrapper.find('[data-test=view-cone]').exists()).toBe(false)
    // 3.2 px per metre about the middle of the 400 px box, north up.
    await wrapper.setProps({
      viewCone: {
        polygon: [
          { x: 5, y: -5 },
          { x: 5, y: 5 },
          { x: 50, y: 20 },
          { x: 50, y: -20 },
        ],
        apex: { x: -10, y: 0 },
        headingRad: 0,
      },
    })
    const cone = wrapper.find('[data-test=view-cone]')
    expect(cone.find('polygon').attributes('points')).toBe(
      '216.0,216.0 216.0,184.0 360.0,136.0 360.0,264.0',
    )
    expect(cone.find('[data-test=view-cone-apex]').attributes()).toMatchObject({
      cx: '168',
      cy: '200',
    })
    // Drawn first: under the ring, the markers and the rover; the overlay takes no pointer.
    expect(wrapper.find('svg').element.firstElementChild).toBe(cone.element)
    expect(wrapper.find('svg').classes()).toContain('pointer-events-none')
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
    // World (x, y) to its pixel's alpha: the disk grid starts at world vertex (-128, -128).
    const alpha = (x: number, y: number) =>
      data.data[((height - 1 - (y + 128)) * width + (x + 128)) * 4 + 3]
    expect(alpha(-10, -10)).toBe(255)
    expect(alpha(10, 10)).toBe(255)
    expect(alpha(10, -10)).toBe(0)
    expect(alpha(-10, 10)).toBe(0)
    // Ground that is in, beyond the 60 m survey: the map's background.
    expect(alpha(-60, -60)).toBe(0)

    const arrived = ground.place(southEast!)!
    view.value = groundView(ground, stopManifest.heightRange)
    await nextTick()
    expect(puts.slice(3).map((put) => put.dirty)).toEqual([dirty(arrived)])
    expect(alpha(10, -10)).toBe(255)
    expect(alpha(-10, 10)).toBe(0)
  })

  it('paints the background beyond the survey and a ring at its edge', async () => {
    // 61 × 61 flat ground around the origin, all seen, in a 20 m survey.
    const size = 61
    const flat = { heights: new Float32Array(size * size), width: size, height: size, cellSize: 1 }
    const seen = new Uint8Array(size * size).fill(1)
    puts.length = 0
    const wrapper = await mountSuspended(StopMap, {
      props: {
        terrain: { grid: flat, origin: { i: -30, j: -30 } },
        fog: { seen, fade: settled(seen), sight: undefined },
        center: { x: 0, y: 0 },
        radius: 20,
      },
    })
    await nextTick()
    const data = puts.at(-1)!.data.data
    let beyond = 0
    let mismatches = 0
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const outside = Math.hypot(i - 30, j - 30) > 20
        const a = data[((size - 1 - j) * size + i) * 4 + 3]
        if (a !== (outside ? 0 : 255)) mismatches++
        if (outside) beyond++
      }
    }
    expect(beyond).toBeGreaterThan(0)
    expect(mismatches).toBe(0)
    const ring = wrapper.find('[data-test=survey-ring]')
    expect(ring.exists()).toBe(true)
    expect(ring.classes()).toContain('stroke-(--ui-text-muted)')
    // The map fits the survey: its 400 px box less 8 px padding each side spans 40 m.
    expect(Number(ring.attributes('r'))).toBeCloseTo((400 - 16) / 2, 6)
  })

  it('paints the three ground states, and recolours only what a new sight changes', async () => {
    // 60 × 60 flat ground: west third never seen, middle third seen before, east third in sight.
    const size = 60
    const flat = { heights: new Float32Array(size * size), width: size, height: size, cellSize: 1 }
    const seen = new Uint8Array(size * size)
    const sightOf = (from: number) => {
      const mask = new Uint8Array(size * size)
      for (let j = 0; j < size; j++) for (let i = from; i < size; i++) mask[j * size + i] = 1
      return mask
    }
    for (let j = 0; j < size; j++) for (let i = 20; i < size; i++) seen[j * size + i] = 1
    const sight = shallowRef(sightOf(40))
    const terrain = { grid: flat, origin: { i: -30, j: -30 } }
    const fade = settled(seen)
    puts.length = 0
    const wrapper = await mountSuspended(
      defineComponent({
        setup: () => () =>
          h(StopMap, {
            terrain,
            fog: { seen, fade, sight: sight.value },
            center: { x: 0, y: 0 },
            // Past the grid's corners: the whole grid lies within the survey.
            radius: 43,
          }),
      }),
    )
    await nextTick()
    const data = puts.at(-1)!.data.data
    const light = reliefLight(hillshadeAt(0, 0))
    const classes = {
      inSight: groundRgb(0, true).map((c) => c * light),
      seenBefore: groundRgb(0, false).map((c) => c * light),
      fogLight: [...FOG_FILL.light],
      fogDark: [...FOG_FILL.dark],
    }
    const count = () => {
      const counts = { inSight: 0, seenBefore: 0, fog: 0 }
      for (let p = 0; p < size * size; p++) {
        const rgb = [data[4 * p]!, data[4 * p + 1]!, data[4 * p + 2]!]
        let best = ''
        let bestD = Infinity
        for (const [name, ref] of Object.entries(classes)) {
          const d = Math.hypot(rgb[0]! - ref[0]!, rgb[1]! - ref[1]!, rgb[2]! - ref[2]!)
          if (d < bestD) [best, bestD] = [name, d]
        }
        counts[best.startsWith('fog') ? 'fog' : (best as 'inSight' | 'seenBefore')]++
      }
      return counts
    }
    // The legend names the seen-before tint beside the height ramp.
    expect(wrapper.find('[data-test=legend-seen]').text()).toBe('seen before')
    const three = count()
    expect(three.inSight).toBe(20 * size)
    // The fog's soft edge lies on the revealed side, over at most two columns of the middle third.
    expect(three.fog).toBeGreaterThanOrEqual(20 * size)
    expect(three.fog).toBeLessThanOrEqual(22 * size)
    expect(three.seenBefore).toBe(size * size - three.inSight - three.fog)

    // The rover moves: the east half is in sight. Only the columns that changed are repainted.
    const before = puts.length
    sight.value = sightOf(30)
    await nextTick()
    await nextTick()
    expect(puts.slice(before).map((put) => put.dirty)).toEqual([[30, 0, 10, size]])
    const moved = count()
    expect(moved.inSight).toBe(30 * size)
    expect(moved.fog).toBe(three.fog)
  })
})
