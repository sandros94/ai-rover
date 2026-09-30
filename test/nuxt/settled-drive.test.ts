import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { ComputedRef } from 'vue'
import { defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { UApp } from '#components'
import {
  encodeTraceBlock,
  parseJourneyKey,
  segmentManifestKey,
  segmentTraceKey,
  sliceGate,
  sliceReleaseAt,
} from '#shared/utils/drive'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import MissionDashboard from '~/components/dashboard/MissionDashboard.vue'
import { JOURNEY_FIXTURE, journeyFixture } from '../unit/client/helpers'

const { missionId, segmentId, startedAt } = JOURNEY_FIXTURE
const { record, segmentManifest, slices, files, stopKeys } = journeyFixture()
/** The stop the drive reached: nothing of it is served, as the drive's replay needs none. */
const REACHED = `missions/${missionId}/stops/1.json`
const { sliceSeconds } = segmentManifest
const last = slices.length - 1
/** The segment row's end: the release of its last slice from the row's start. */
const endsAt = sliceReleaseAt(startedAt, last, sliceSeconds)

/**
 * `/journey/{key}` over the fixture journey as the route serves it: each slice, trace and trace
 * block released from the row's start, and the stored manifest one rewritten by a run that
 * prepared the drive 96.8 s after the one that started it.
 */
async function journeyFetch(input: string): Promise<Response> {
  const key = input.replace(/^\/journey\//, '')
  if (key === segmentManifestKey(segmentId)) {
    return Response.json({ ...segmentManifest, startedAt: startedAt + 96_800 })
  }
  const parsed = parseJourneyKey(key)
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
            files.get(segmentTraceKey(segmentId, parsed.from + k))!,
          ),
        )
      : files.get(key)
  return bytes
    ? new Response(bytes as Uint8Array<ArrayBuffer>)
    : new Response(null, { status: 404 })
}

function state(): MissionStateJson {
  const stop = { id: 's0', index: 0, x: 0, y: 0, headingRad: 0 }
  const { x, y, headingRad } = record.outcome.endPose
  return {
    now: new Date(endsAt + 60_000).toISOString(),
    mission: {
      id: missionId,
      status: 'active',
      solsEpoch: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      rules: structuredClone(DEFAULT_MISSION_RULES),
    },
    currentStop: { id: 's1', index: 1, x, y, headingRad, manifestKey: REACHED },
    round: null,
    segment: null,
    release: null,
    flags: null,
    pause: null,
    lastSegment: {
      id: segmentId,
      status: 'arrived',
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      fromStopId: stop.id,
      distanceM: record.outcome.distanceM,
    },
    trail: [
      { index: 0, x: 0, y: 0, manifestKey: stopKeys.manifestKey, reachedBy: null },
      { index: 1, x, y, manifestKey: REACHED, reachedBy: null },
    ],
    deaths: [],
    tally: {
      distanceM: record.outcome.distanceM,
      stops: 2,
      arrived: 1,
      stoppedShort: 0,
      failed: 0,
    },
  } as unknown as MissionStateJson
}

/** The track the dashboard hands the map, read where the map would draw it. */
let track: { rover: ComputedRef<{ x: number; y: number } | undefined> } | undefined
const MapStub = defineComponent({
  name: 'MissionMap',
  props: ['state', 'signedIn', 'highlight', 'track', 'objects'],
  emits: ['submitted', 'stale', 'ground'],
  setup(props, { slots }) {
    track = props.track as typeof track
    const planning = { onHover: () => {}, onPick: () => {} }
    return () =>
      slots.default?.({ stage: () => ({ center: { x: 0, y: 0 }, radius: 60 }), planning })
  },
})
const StageStub = defineComponent({ name: 'StopStage', setup: () => () => h('div') })

const attached: { unmount: () => void }[] = []

/** The HUD area, as laid out in a desktop browser. */
const AREA = { left: 0, top: 48, width: 1280, height: 720 }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(endsAt + 60_000)
  vi.stubGlobal('fetch', journeyFetch)
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
  track = undefined
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the dashboard on a settled drive whose stored manifest names a later start', () => {
  it("plays it from the row's start to its end: the rover at the goal, arrived", async () => {
    expect(record.outcome.kind).toBe('arrived')
    const wrapper = await mountSuspended(
      defineComponent({
        render: () =>
          h(UApp, null, {
            default: () => h(MissionDashboard, { state: state(), error: null, serverOffsetMs: 0 }),
          }),
      }),
      { global: { stubs: { MissionMap: MapStub, StopStage: StageStub } }, attachTo: document.body },
    )
    attached.push(wrapper)
    const { x, y } = record.outcome.endPose
    await vi.waitFor(
      async () => {
        await flushPromises()
        const rover = track?.rover.value
        expect(rover?.x).toBeCloseTo(x, 3)
        expect(rover?.y).toBeCloseTo(y, 3)
      },
      { timeout: 10_000, interval: 50 },
    )
    // The drive log ends with the arrival.
    await wrapper.find('[data-test=panels-menu]').trigger('click')
    await flushPromises()
    ;(document.body.querySelector('[data-test=panel-toggle-events]') as HTMLElement).click()
    await flushPromises()
    const icons = wrapper
      .findAll('[data-panel=events] [data-test=event-icon]')
      .map((icon) => icon.attributes('data-icon'))
    expect(icons[0]).toBe('i-lucide-flag')
  }, 30_000)
})
