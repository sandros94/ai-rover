import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { UApp } from '#components'
import { currentSight } from '#shared/utils/client/sight'
import { KEYFRAME_STRIDE } from '#shared/utils/drive'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
import type { useSegmentPlayback } from '~/composables/useSegmentPlayback'
import type { StopFog } from '~/composables/useStopFog'
import { useStopFog } from '~/composables/useStopFog'
import { SIGHT_INTERVAL_MS } from '~/composables/useCurrentSight'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import StopStage from '~/components/map/StopStage.vue'
import { JOURNEY_FIXTURE, journeyFixture } from '../unit/client/helpers'

// The viewshed itself, counted.
vi.mock('#shared/utils/client/sight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/utils/client/sight')>()
  return { ...actual, currentSight: vi.fn<typeof actual.currentSight>(actual.currentSight) }
})

/** Every sight each view was handed, in order. */
const handed = { map: [] as (Uint8Array | undefined)[], scene: [] as (Uint8Array | undefined)[] }

// The views need a canvas and WebGL; what matters here is the sight they are handed.
vi.mock('~/components/map/StopMap.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'StopMap',
      props: { fog: { type: Object, default: undefined } },
      setup:
        (props, { slots }) =>
        () => {
          handed.map.push((props.fog as StopFog | undefined)?.sight)
          return vue.h('div', { 'data-test': 'map' }, slots.default?.())
        },
    }),
  }
})
vi.mock('~/components/scene/DiskScene.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'DiskScene',
      props: { fog: { type: Object, default: undefined } },
      setup: (props) => () => {
        handed.scene.push((props.fog as StopFog | undefined)?.sight)
        return vue.h('div', { 'data-test': 'scene' })
      },
    }),
  }
})

const { missionId, segmentId, startedAt } = JOURNEY_FIXTURE
const { files, record, stopKeys } = journeyFixture()

/** The playing segment's frame, moved by the test; no slices load. */
const frame = shallowRef<Float32Array>()
mockNuxtImport<typeof useSegmentPlayback>('useSegmentPlayback', () => () => playback())
function playback() {
  const noop = () => {}
  return {
    manifest: shallowRef(),
    frame,
    keyframes: shallowRef(),
    totals: shallowRef(),
    pathBefore: shallowRef(new Float32Array(0)),
    events: shallowRef([]),
    reveals: shallowRef([]),
    heldReveals: shallowRef([]),
    outcome: shallowRef(),
    simTime: ref(0),
    jumpedTo: ref(0),
    liveTime: ref(0),
    heldUntil: ref(0),
    mode: ref('live'),
    rate: ref(1),
    paused: ref(false),
    error: shallowRef(null),
    seek: noop,
    setRate: noop,
    goLive: noop,
    togglePlay: noop,
  } as unknown as ReturnType<typeof useSegmentPlayback>
}

/** The recorded drive's frame at keyframe `k`. */
const keyframe = (k: number) =>
  record.keyframes.data.slice(k * KEYFRAME_STRIDE, (k + 1) * KEYFRAME_STRIDE)

function state(): MissionStateJson {
  const stop = { id: 's0', index: 0, x: 0, y: 0, headingRad: 0, manifestKey: stopKeys.manifestKey }
  return {
    now: new Date(startedAt).toISOString(),
    mission: {
      id: missionId,
      status: 'active',
      solsEpoch: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      rules: structuredClone(DEFAULT_MISSION_RULES),
    },
    currentStop: stop,
    round: null,
    segment: { id: segmentId, startedAt: new Date(startedAt).toISOString(), fromStopId: stop.id },
    release: null,
    flags: null,
    pause: null,
    lastSegment: null,
    trail: [{ index: 0, x: 0, y: 0, manifestKey: stopKeys.manifestKey, reachedBy: null }],
    deaths: [],
    tally: { distanceM: 0, stops: 1, arrived: 0, stoppedShort: 0, failed: 0, resets: 0 },
  } as unknown as MissionStateJson
}

/** The HUD area, as laid out in a desktop browser: the 2D map panel floats over the scene. */
const AREA = { left: 0, top: 48, width: 1280, height: 720 }

const attached: { unmount: () => void }[] = []

beforeEach(() => {
  handed.map.length = 0
  handed.scene.length = 0
  vi.mocked(currentSight).mockClear()
  frame.value = keyframe(0)
  vi.stubGlobal('fetch', async (input: string) => {
    const bytes = files.get(input.replace(/^\/journey\//, ''))
    return bytes
      ? new Response(bytes as Uint8Array<ArrayBuffer>)
      : new Response(null, { status: 404 })
  })
  // The route previews' planner runs in a worker; none is asked for here.
  vi.stubGlobal(
    'Worker',
    class {
      addEventListener() {}
      postMessage() {}
      terminate() {}
    },
  )
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        matches: true,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList,
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...AREA,
    x: AREA.left,
    y: AREA.top,
    right: AREA.left + AREA.width,
    bottom: AREA.top + AREA.height,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  for (const wrapper of attached.splice(0)) wrapper.unmount()
  useState('ai-rover:panels').value = null
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const distinct = (sights: (Uint8Array | undefined)[]) =>
  new Set(sights.filter((s): s is Uint8Array => s !== undefined))

describe('the fog on the dashboard', () => {
  it('computes the sight once per recompute for the scene and the 2D map panel together', async () => {
    const wrapper = await mountSuspended(
      defineComponent({
        render: () =>
          h(UApp, null, {
            default: () => h(MissionDashboard, { state: state(), error: null, serverOffsetMs: 0 }),
          }),
      }),
      { attachTo: document.body },
    )
    attached.push(wrapper)
    // Both views: the scene underneath, the 2D map in its floating panel.
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test=scene-layer] [data-test=scene]').exists()).toBe(true)
      expect(wrapper.find('[data-panel=map2d] [data-test=map]').exists()).toBe(true)
      expect(handed.map.at(-1)).toBeDefined()
    })

    // The rover drives on, a keyframe every 50 ms for three sight intervals.
    const steps = Math.ceil((3 * SIGHT_INTERVAL_MS) / 50)
    for (let k = 1; k <= steps; k++) {
      frame.value = keyframe(k)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, SIGHT_INTERVAL_MS + 300))
    await flushPromises()

    const computed = vi.mocked(currentSight).mock.results.map((r) => r.value as Uint8Array)
    // Recomputed while driving, not only at the start.
    expect(computed.length).toBeGreaterThanOrEqual(3)
    // Each recompute ran once, and both views were handed the same result.
    expect(distinct(handed.map)).toEqual(new Set(computed))
    expect(distinct(handed.scene)).toEqual(new Set(computed))
    expect(handed.map.at(-1)).toBe(computed.at(-1))
    expect(handed.scene.at(-1)).toBe(computed.at(-1))
  })
})

describe('the stop on the dashboard', () => {
  it('is loaded through the manifest key the state names, its mask and pack through the manifest', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      const key = input.replace(/^\/journey\//, '')
      asked.push(key)
      const bytes = files.get(key)
      return bytes
        ? new Response(bytes as Uint8Array<ArrayBuffer>)
        : new Response(null, { status: 404 })
    })
    const wrapper = await mountSuspended(
      defineComponent({
        render: () =>
          h(UApp, null, {
            default: () => h(MissionDashboard, { state: state(), error: null, serverOffsetMs: 0 }),
          }),
      }),
      { attachTo: document.body },
    )
    attached.push(wrapper)
    // The fog is drawn once the mask is in, over the ground the pack brought.
    await vi.waitFor(() => expect(handed.map.at(-1)).toBeDefined())
    const stopKeysAsked = asked.filter((key) => key.startsWith('missions/'))
    expect(stopKeysAsked[0]).toBe(stopKeys.manifestKey)
    expect(new Set(stopKeysAsked)).toEqual(
      new Set([stopKeys.manifestKey, stopKeys.revealedKey, stopKeys.packKey]),
    )
  })
})

describe('the terrain loading on the dashboard', () => {
  it('shows one progress indicator for the scene and the 2D map panel while chunks arrive', async () => {
    // The stop's manifest arrives; its chunks never do.
    vi.stubGlobal('fetch', async (input: string) => {
      const key = input.replace(/^\/journey\//, '')
      if (key.startsWith('terrain/') || key.endsWith('.pack'))
        return new Promise<Response>(() => {})
      const bytes = files.get(key)
      return bytes
        ? new Response(bytes as Uint8Array<ArrayBuffer>)
        : new Response(null, { status: 404 })
    })
    const wrapper = await mountSuspended(
      defineComponent({
        render: () =>
          h(UApp, null, {
            default: () => h(MissionDashboard, { state: state(), error: null, serverOffsetMs: 0 }),
          }),
      }),
      { attachTo: document.body },
    )
    attached.push(wrapper)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-panel=map2d] [data-test=map]').exists()).toBe(true)
      expect(wrapper.find('[data-test=terrain-progress]').text()).toMatch(
        /Loading terrain 0 \/ \d+/,
      )
    })
    await flushPromises()
    const shown = wrapper.findAll('[data-test=terrain-progress]')
    expect(shown).toHaveLength(1)
    expect(wrapper.find('[data-panel=map2d] [data-test=terrain-progress]').exists()).toBe(false)
  })
})

describe('useStopFog as playback jumps', () => {
  const size = 9
  const grid = { heights: new Float32Array(size * size), width: size, height: size, cellSize: 1 }
  const origin = { i: 0, j: 0 }

  it('draws the reveals up to a jump settled at once, and fades those played into', async () => {
    const reveals = shallowRef<{ t: number; vertices: Uint32Array }[]>([])
    const settledUntil = ref(0)
    let fog!: ReturnType<typeof useStopFog>
    await mountSuspended(
      defineComponent({
        setup() {
          fog = useStopFog({
            seen: () => new Uint8Array(size * size),
            reveals: () => reveals.value,
            settledUntil: () => settledUntil.value,
            ground: () => ({ grid, origin }),
            eye: () => undefined,
            sight: () => undefined,
          })
          return () => h('div')
        },
      }),
    )
    const times = () => fog.value.fade!.fog.revealedAt
    // A seek to 60 s: what the drive revealed up to there is lifted and settled in the same tick.
    settledUntil.value = 60
    reveals.value = [
      { t: 10, vertices: Uint32Array.of(1) },
      { t: 50, vertices: Uint32Array.of(2) },
    ]
    await nextTick()
    expect(fog.value.seen![1]).toBe(1)
    expect(fog.value.seen![2]).toBe(1)
    expect(times()[1]).toBe(-Infinity)
    expect(times()[2]).toBe(-Infinity)

    // Played on into a reveal at 61 s: it fades in.
    reveals.value = [...reveals.value, { t: 61, vertices: Uint32Array.of(3) }]
    await vi.waitFor(() => expect(fog.value.seen![3]).toBe(1))
    expect(Number.isFinite(times()[3])).toBe(true)

    // A seek back to 20 s drops the later reveals at once.
    settledUntil.value = 20
    reveals.value = reveals.value.slice(0, 1)
    await nextTick()
    expect(Array.from(fog.value.seen!.subarray(1, 4))).toEqual([1, 0, 0])
  })
})

describe('StopStage on its own', () => {
  function grid(size: number) {
    const heights = new Float32Array(size * size).map((_, k) => (k % size) * 0.1)
    return { heights, width: size, height: size, cellSize: 1 }
  }
  const props = {
    view: '2d' as const,
    terrain: { grid: grid(65), origin: { i: -32, j: -32 } },
    seen: new Uint8Array(65 * 65).fill(1),
    heightAt: () => 0,
    loading: { loaded: 1, total: 1, error: null },
    center: { x: 0, y: 0 },
    radius: 32,
    mastHeight: 2,
    rover: { x: 0, y: 0, headingRad: 0 },
  }

  it('computes its own sight when no fog is handed to it', async () => {
    await mountSuspended(StopStage, { props })
    await flushPromises()
    expect(currentSight).toHaveBeenCalledTimes(1)
    expect(handed.map.at(-1)).toBe(vi.mocked(currentSight).mock.results[0]!.value)
  })

  it('draws the fog it is handed and computes none', async () => {
    const sight = new Uint8Array(65 * 65)
    await mountSuspended(StopStage, {
      props: { ...props, fog: { stopSeen: props.seen, seen: props.seen, fade: undefined, sight } },
    })
    await flushPromises()
    await nextTick()
    expect(currentSight).not.toHaveBeenCalled()
    expect(handed.map.at(-1)).toBe(sight)
  })
})
