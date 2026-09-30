import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { useState } from '#imports'
import { UApp } from '#components'
import { DEFAULT_LIVE_MARGIN_SECONDS, fogSurface, gridHeightAt } from '#shared/utils/client'
import {
  encodeTrace,
  encodeTraceBlock,
  interpolatePose,
  KEYFRAME_FIELDS,
  parseJourneyKey,
  segmentTraceKey,
  sliceGate,
  sliceReleaseAt,
} from '#shared/utils/drive'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { RevealedMask } from '#shared/utils/terrain'
import { encodeRevealedMask, revealedKey, revealedOverDisk } from '#shared/utils/terrain'
import type { MissionStateJson } from '~/composables/useMissionState'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'
import { JOURNEY_FIXTURE, journeyFixture } from '../unit/client/helpers'

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const Z = KEYFRAME_FIELDS.indexOf('z')

/** What the 3D scene was handed, render by render: whether the rover is drawn, and where. */
interface Drawn {
  shown: boolean
  z: number
  /** Height of the ground as drawn under the rover. */
  ground: number | undefined
}
const drawn: Drawn[] = []

// WebGL is not needed: what matters is what the scene is handed.
vi.mock('~/components/map/StopMap.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'StopMap',
      setup:
        (_, { slots }) =>
        () =>
          vue.h('div', slots.default?.()),
    }),
  }
})
vi.mock('~/components/scene/StopScene.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'StopScene',
      props: {
        frame: { type: Float32Array, required: true },
        roverShown: { type: Boolean, default: true },
        drawnHeightAt: { type: Function, default: undefined },
      },
      setup: (props) => () => {
        const frame = props.frame
        const at = props.drawnHeightAt as ((x: number, y: number) => number | undefined) | undefined
        drawn.push({ shown: props.roverShown, z: frame[Z]!, ground: at?.(frame[X]!, frame[Y]!) })
        return vue.h('div', { 'data-test': 'scene' })
      },
    }),
  }
})

const { missionId, stopIndex, segmentId, startedAt } = JOURNEY_FIXTURE
const { files, mask, disk, stopManifest, record, segmentManifest, traces } = journeyFixture()
const { sliceSeconds } = segmentManifest

/** Wall time mid-drive: live stands in slice 20, with twenty slices of reveals before it. */
const now = sliceReleaseAt(startedAt, 20, sliceSeconds) + 6000
const live = (now - startedAt) / 1000 - sliceSeconds - DEFAULT_LIVE_MARGIN_SECONDS
const pose = interpolatePose(record.keyframes, live)
const rover = { x: pose[X]!, y: pose[Y]! }

/**
 * The stop's mask with a hole of `HOLE_M` around where the rover stands at live, which the drive's
 * first trace reveals instead: only the traces tell the ground under the rover is seen.
 */
const HOLE_M = 20
const inHole = (x: number, y: number) => Math.hypot(x - rover.x, y - rover.y) < HOLE_M
function holedMask(): RevealedMask {
  const cells = mask.vertexCount - 1
  const chunks = new Map<string, Uint8Array>()
  for (const [key, bits] of mask.chunks) {
    const [cx, cy] = key.split(',').map(Number) as [number, number]
    const out = bits.slice()
    for (let b = 0; b < mask.vertexCount; b++) {
      for (let a = 0; a < mask.vertexCount; a++) {
        if (inHole((cx * cells + a) * mask.cellSize, (cy * cells + b) * mask.cellSize)) {
          out[b * mask.vertexCount + a] = 0
        }
      }
    }
    chunks.set(key, out)
  }
  return { ...mask, chunks }
}
const holed = holedMask()
const stopSeen = revealedOverDisk(holed, disk)
const hole = Uint32Array.from(
  Array.from(revealedOverDisk(mask, disk)).flatMap((seen, k) => {
    const { width, cellSize } = disk.grid
    const i = (k % width) + disk.origin.i
    const j = Math.floor(k / width) + disk.origin.j
    return seen && inHole(i * cellSize, j * cellSize) ? [k] : []
  }),
)
const first = { ...traces[0]!, reveals: [{ t: 0, vertices: hole }, ...traces[0]!.reveals] }
const served = new Map(files)
served.set(revealedKey(missionId, stopIndex), encodeRevealedMask(holed))
served.set(segmentTraceKey(segmentId, 0), encodeTrace(first))

/** Requests held back until the test lets them through. */
let hold: { traces: Promise<void>; slices: Promise<void> }
async function journeyFetch(input: string): Promise<Response> {
  const key = input.replace(/^\/journey\//, '')
  const parsed = parseJourneyKey(key)
  if (parsed?.kind === 'segment-trace' || parsed?.kind === 'segment-trace-block') {
    await hold.traces
  }
  if (parsed?.kind === 'segment-slice') await hold.slices
  const at =
    parsed?.kind === 'segment-trace-block'
      ? parsed.to
      : parsed?.kind === 'segment-slice' || parsed?.kind === 'segment-trace'
        ? parsed.index
        : undefined
  if (at !== undefined && !sliceGate({ startedAt, sliceSeconds }, at, Date.now()).released) {
    return new Response(null, { status: 404, headers: { 'x-release-at': 'later' } })
  }
  const bytes =
    parsed?.kind === 'segment-trace-block'
      ? encodeTraceBlock(
          Array.from({ length: parsed.to - parsed.from + 1 }, (_, k) =>
            served.get(segmentTraceKey(segmentId, parsed.from + k))!,
          ),
        )
      : served.get(key)
  return bytes
    ? new Response(bytes as Uint8Array<ArrayBuffer>)
    : new Response(null, { status: 404 })
}

function state(): MissionStateJson {
  const stop = { id: 's0', index: stopIndex, x: 0, y: 0, headingRad: 0 }
  return {
    now: new Date(now).toISOString(),
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
    trail: [{ index: stopIndex, x: 0, y: 0, reachedBy: null }],
    deaths: [],
    tally: { distanceM: 0, stops: 1, arrived: 0, stoppedShort: 0, failed: 0, resets: 0 },
  } as unknown as MissionStateJson
}

const attached: { unmount: () => void }[] = []

async function mountDashboard() {
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
  return wrapper
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  drawn.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  vi.stubGlobal('fetch', journeyFetch)
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
})

afterEach(() => {
  for (const wrapper of attached.splice(0)) wrapper.unmount()
  useState('ai-rover:panels').value = null
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

/** Waits until the rover is drawn, then gives every render from the first it is drawn in. */
async function roverDrawn(): Promise<Drawn[]> {
  await vi.waitFor(() => expect(drawn.some((d) => d.shown)).toBe(true), {
    timeout: 10_000,
    interval: 20,
  })
  // A few frames and a fog tick more, to see it stay on the ground.
  await pause(300)
  return drawn.slice(drawn.findIndex((d) => d.shown))
}

describe('the rover on the dashboard, opened mid-drive', () => {
  it('stands on fog before the reveals: the ground the traces reveal is drawn lower or higher', () => {
    const fogged = fogSurface(disk.grid, { seen: stopSeen }).heights
    const under = gridHeightAt(fogged, { ...disk.grid, origin: disk.origin }, rover.x, rover.y)!
    expect(Math.abs(under - pose[Z]!)).toBeGreaterThan(0.03)
    expect(stopManifest.revealedKey).toBe(revealedKey(missionId, stopIndex))
  })

  it('draws no rover from the live slice before the traces are in, then stands it on true ground', async () => {
    const traced = Promise.withResolvers<void>()
    const sliced = Promise.withResolvers<void>()
    hold = { traces: traced.promise, slices: Promise.resolve() }
    vi.stubGlobal('fetch', async (input: string) => {
      const response = await journeyFetch(input)
      if (input.includes('/slices/')) sliced.resolve()
      return response
    })
    await mountDashboard()
    await sliced.promise
    // The slice is in, the ground and the mask too: still no rover while the traces are out.
    await pause(400)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every((d) => !d.shown)).toBe(true)

    traced.resolve()
    const shown = await roverDrawn()
    for (const d of shown) {
      expect(d.shown).toBe(true)
      expect(d.ground).toBeDefined()
      expect(Math.abs(d.ground! - d.z)).toBeLessThan(0.01)
    }
  })

  it('does the same with the traces in first and the live slice after', async () => {
    const sliced = Promise.withResolvers<void>()
    hold = { traces: Promise.resolve(), slices: sliced.promise }
    await mountDashboard()
    await pause(400)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every((d) => !d.shown)).toBe(true)

    sliced.resolve()
    const shown = await roverDrawn()
    for (const d of shown) {
      expect(d.shown).toBe(true)
      expect(Math.abs(d.ground! - d.z)).toBeLessThan(0.01)
    }
  })
})
