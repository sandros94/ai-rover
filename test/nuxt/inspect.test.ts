import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { MapObject, RoverObject } from '#shared/utils/client'
import { mapObjects } from '#shared/utils/client'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'

// The scene needs WebGL; these tests inspect the 2D map.
vi.mock('~/components/scene/DiskScene.vue', async () => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name: 'DiskScene', setup: () => () => null }) }
})

/** The map lays itself out in a 400 × 400 px box whose corner sits at client (10, 20). */
const BOX = { left: 10, top: 20, width: 400, height: 400 }

const EPOCH = '2026-09-01T00:00:00.000Z'

/*
 * The 120 m disk box fits 384 px: 3.2 px per metre, the disk centre at (200, 200). The death at
 * (20, 0) m is drawn at (264, 200) px, the submission's goal at (0, 20) m at (200, 136) px.
 */
const OBJECTS: MapObject[] = mapObjects({
  mission: { solsEpoch: EPOCH },
  currentStop: { index: 1 },
  trail: [
    { index: 0, x: 0, y: 0, reachedBy: null },
    {
      index: 1,
      x: -20,
      y: -10,
      reachedBy: { segmentId: 'seg-1', number: 1, fromIndex: 0, at: '2026-09-02T00:00:00.000Z' },
    },
  ],
  deaths: [
    {
      x: 20,
      y: 0,
      segmentId: 'seg-2',
      number: 2,
      fromIndex: 1,
      reasons: ['stuck'],
      at: '2026-09-03T00:00:00.000Z',
      distanceM: 23.5,
    },
  ],
  round: {
    anchor: { x: -20, y: -10 },
    submissions: [
      {
        id: 'sub-1',
        goal: { x: 0, y: 20 },
        likes: 4,
        submitter: { displayName: 'Ada', avatarUrl: null },
        judgment: { verdict: 'review', risk: 0.9 },
      },
    ],
  },
})

/** The rover rests on stop 1, at (-20, -10) m: (136, 232) px. */
const REST = { x: -20, y: -10, headingRad: 0 }
const rover = (at: { x: number; y: number }): RoverObject => ({
  kind: 'rover',
  id: 'rover',
  ...at,
  headingRad: 0,
  status: 'waiting',
  speedMps: null,
  progress: null,
})

async function mountStage(at = REST) {
  const wrapper = await mountSuspended(StopStage, {
    props: {
      view: '2d',
      heightAt: () => 0,
      loading: { loaded: 0, total: 0, error: null },
      center: { x: 0, y: 0 },
      radius: 60,
      rover: at,
      trail: [
        { x: 0, y: 0 },
        { x: -20, y: -10 },
      ],
      deaths: [{ x: 20, y: 0 }],
      submissions: [{ id: 'sub-1', goal: { x: 0, y: 20 } }],
      objects: OBJECTS,
      roverObject: rover(at),
    },
  })
  await flushPromises()
  return wrapper
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    clientX: BOX.left + x,
    clientY: BOX.top + y,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    ...init,
  })
}

const card = () => document.body.querySelector<HTMLElement>('[data-test=object-card]')

/** Screen position of the rover marker, from its transform. */
function roverAt(wrapper: {
  find: (s: string) => { attributes: (a: string) => string | undefined }
}) {
  const match = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(
    wrapper.find('[data-test=rover-marker]').attributes('transform') ?? '',
  )
  return { x: Math.round(Number(match?.[1])), y: Math.round(Number(match?.[2])) }
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: BOX.left,
    y: BOX.top,
    right: BOX.left + BOX.width,
    bottom: BOX.top + BOX.height,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  useMapFocus().clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('hover cards on the 2D map', () => {
  it('shows the card of the object within 12 px of the pointer, and hides it past that', async () => {
    const wrapper = await mountStage()
    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointermove', 264 + 11, 200))
    await flushPromises()
    expect(card()?.dataset.kind).toBe('death')
    expect(card()?.textContent).toContain('Segment 2')
    expect(card()?.textContent).toContain('stuck')
    expect(card()?.textContent).toContain('23.5 m')

    map.dispatchEvent(pointer('pointermove', 264 + 13, 200))
    await flushPromises()
    expect(card()).toBeNull()
  })

  it("shows a submission's author, goal distance and bearing, verdict and LGTMs", async () => {
    const wrapper = await mountStage()
    wrapper.find('[data-test=map]').element.dispatchEvent(pointer('pointermove', 202, 138))
    await flushPromises()
    expect(card()?.dataset.kind).toBe('submission')
    expect(card()?.textContent).toContain('Ada')
    expect(card()?.textContent).toContain('36 m · 34° NE')
    expect(card()?.textContent).toContain('4 LGTM')
  })

  it('prefers the rover over the stop it stands on', async () => {
    const wrapper = await mountStage()
    wrapper.find('[data-test=map]').element.dispatchEvent(pointer('pointermove', 136, 232))
    await flushPromises()
    expect(card()?.dataset.kind).toBe('rover')
    expect(card()?.textContent).toContain('Waiting for a destination')
  })

  it('hides the card when the pointer leaves the map', async () => {
    const wrapper = await mountStage()
    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointermove', 264, 200))
    await flushPromises()
    expect(card()).not.toBeNull()
    map.dispatchEvent(pointer('pointerleave', 0, 0))
    await flushPromises()
    expect(card()).toBeNull()
  })
})

describe('focusing from the 2D map', () => {
  it('focuses the object under a click instead of picking there', async () => {
    const wrapper = await mountStage()
    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointerdown', 266, 200))
    map.dispatchEvent(pointer('pointerup', 266, 200))
    await flushPromises()
    expect(useMapFocus().focused.value).toBe('death:seg-2')
    expect(wrapper.emitted('pick')).toBeUndefined()

    // Away from every object a click still picks.
    map.dispatchEvent(pointer('pointerdown', 300, 300))
    map.dispatchEvent(pointer('pointerup', 300, 300))
    expect(wrapper.emitted('pick')).toHaveLength(1)
  })

  it('shows the card on a first tap and focuses on a second', async () => {
    const wrapper = await mountStage()
    const map = wrapper.find('[data-test=map]').element
    const tap = async () => {
      map.dispatchEvent(pointer('pointerdown', 264, 200, { pointerType: 'touch' }))
      map.dispatchEvent(pointer('pointerup', 264, 200, { pointerType: 'touch' }))
      // A lifted finger leaves the element too.
      map.dispatchEvent(pointer('pointerleave', 264, 200, { pointerType: 'touch' }))
      await flushPromises()
    }
    await tap()
    expect(card()?.dataset.kind).toBe('death')
    expect(useMapFocus().focused.value).toBeNull()
    await tap()
    expect(useMapFocus().focused.value).toBe('death:seg-2')
    expect(wrapper.emitted('pick')).toBeUndefined()
  })

  it('eases the view onto a focused object', async () => {
    const wrapper = await mountStage()
    useMapFocus().focusOn('death:seg-2')
    await vi.waitFor(() => {
      const death = wrapper.find('[data-test=death-marker]').attributes('data-at')
      expect(death).toBe('200,200')
    })
  })

  it('recentres on the rover and follows it until the map is panned', async () => {
    const wrapper = await mountStage()
    await wrapper.find('[data-test=recenter]').trigger('click')
    expect(useMapFocus().focused.value).toBe('rover')
    await vi.waitFor(() => expect(roverAt(wrapper)).toEqual({ x: 200, y: 200 }))

    const moved = { x: -10, y: 5, headingRad: 0 }
    await wrapper.setProps({ rover: moved, roverObject: rover(moved) })
    await vi.waitFor(() => expect(roverAt(wrapper)).toEqual({ x: 200, y: 200 }))

    const map = wrapper.find('[data-test=map]').element
    map.dispatchEvent(pointer('pointerdown', 300, 300))
    map.dispatchEvent(pointer('pointermove', 340, 300))
    map.dispatchEvent(pointer('pointerup', 340, 300))
    await flushPromises()
    expect(roverAt(wrapper)).toEqual({ x: 240, y: 200 })
    const again = { x: 0, y: 5, headingRad: 0 }
    await wrapper.setProps({ rover: again, roverObject: rover(again) })
    await flushPromises()
    // No longer followed: the rover moves 10 m east on screen, 32 px.
    expect(roverAt(wrapper)).toEqual({ x: 272, y: 200 })
  })
})
