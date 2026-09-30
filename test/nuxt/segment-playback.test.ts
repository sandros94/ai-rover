import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { UApp } from '#components'
import { createOdometer } from '#shared/utils/client/instruments'
import {
  encodeTraceBlock,
  parseJourneyKey,
  segmentTraceBlockKey,
  segmentTraceKey,
  sliceGate,
  sliceReleaseAt,
  statusAt,
  TRACE_BLOCK,
} from '#shared/utils/drive'
import { useDisplayClock } from '~/composables/useDisplayClock'
import { usePlaybackTrack } from '~/composables/usePlaybackTrack'
import { useSegmentPlayback } from '~/composables/useSegmentPlayback'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SpeedOdometer from '~/components/instruments/SpeedOdometer.vue'
import { JOURNEY_FIXTURE, journeyFixture } from '../unit/client/helpers'

const { record, segmentManifest: manifest, slices, files } = journeyFixture()
const { segmentId, sliceSeconds } = manifest
const { startedAt } = JOURNEY_FIXTURE
const whole = createOdometer(record.keyframes)
const sliceUrl = (k: number) => `/journey/segments/${segmentId}/slices/${k}.bin`
const traceUrl = (k: number) => `/journey/segments/${segmentId}/traces/${k}.bin`
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k)

/**
 * A slice past the first trace block whose start falls inside a stop begun in the slice before,
 * so that a first load reads blocks, a single trace and the totals.
 */
const opening = slices.findIndex(
  (s, k) => k > TRACE_BLOCK && s.totals.status !== null && s.totals.status.status !== 'driving',
)
const stop = slices[opening]!.totals.status!
/** Live playback just inside that slice: its start plus the live lag (one slice and 5 s). */
const openAt = startedAt + (opening * sliceSeconds + 0.2 + sliceSeconds + 5) * 1000

const calls: string[] = []

/**
 * `/journey/{key}` over the fixture journey, rebuilt in memory (the unit tests hold it byte for
 * byte against the recorded files), each slice, trace and trace block held back until its release.
 */
async function journeyFetch(input: string): Promise<Response> {
  calls.push(input)
  const key = input.replace(/^\/journey\//, '')
  const parsed = parseJourneyKey(key)
  const last =
    parsed?.kind === 'segment-trace-block'
      ? parsed.to
      : parsed?.kind === 'segment-slice' || parsed?.kind === 'segment-trace'
        ? parsed.index
        : undefined
  if (last !== undefined && !sliceGate({ startedAt, sliceSeconds }, last, Date.now()).released) {
    return new Response(null, { status: 404, headers: { 'x-release-at': 'later' } })
  }
  const bytes =
    parsed?.kind === 'segment-trace-block'
      ? encodeTraceBlock(
          range(parsed.from, parsed.to + 1).map((k) => files.get(segmentTraceKey(segmentId, k))!),
        )
      : files.get(key)
  if (!bytes) return new Response(null, { status: 404 })
  return new Response(bytes as Uint8Array<ArrayBuffer>)
}

let playback: ReturnType<typeof useSegmentPlayback> | undefined
let track: ReturnType<typeof usePlaybackTrack> | undefined

/** The dashboard's playback of the fixture drive, its speed and odometer instrument. */
const Harness = defineComponent({
  setup() {
    const display = useDisplayClock(() => 0)
    playback = useSegmentPlayback(() => ({ id: segmentId, startedAt: new Date(startedAt) }), {
      display,
      serverOffsetMs: () => 0,
    })
    track = usePlaybackTrack(playback)
    return () => {
      const s = track!.snapshot.value
      return s.frame && s.keyframes
        ? h(SpeedOdometer, {
            frame: s.frame,
            events: s.events,
            keyframes: s.keyframes,
            totals: s.totals,
          })
        : h('p', 'loading')
    }
  },
})

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

async function settle(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await flushPromises()
      check()
    },
    { timeout: 5000, interval: 20 },
  )
}

describe('a first load of a drive in progress', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(openAt)
    vi.stubGlobal('fetch', journeyFetch)
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens at live on the live slice and the traces up to it in blocks, reading from the totals', async () => {
    expect(opening).toBeGreaterThan(TRACE_BLOCK)
    expect(sliceReleaseAt(startedAt, opening, sliceSeconds)).toBeLessThanOrEqual(openAt)
    const wrapper = await mountSuspended(
      defineComponent({ render: () => h(UApp, null, { default: () => h(Harness) }) }),
    )
    await settle(() => {
      if (playback!.error.value) throw playback!.error.value
      expect(playback!.frame.value).toBeDefined()
    })
    playback!.togglePlay()
    await nextFrame()
    const t = playback!.simTime.value
    await settle(() => expect(track!.snapshot.value.t).toBe(t))

    expect([...calls].sort()).toEqual(
      [
        `/journey/segments/${segmentId}/manifest.json`,
        sliceUrl(opening),
        ...range(0, Math.floor((opening + 1) / TRACE_BLOCK)).map(
          (b) => `/journey/${segmentTraceBlockKey(segmentId, b)}`,
        ),
        ...range(opening + 1 - ((opening + 1) % TRACE_BLOCK), opening + 1).map(traceUrl),
      ].sort(),
    )
    expect(Math.floor(t / sliceSeconds)).toBe(opening)
    // The stop began before the loaded slice: only its totals know of it.
    expect(t).toBeLessThan(stop.endsAt!)
    expect(playback!.events.value.some((e) => e.t === stop.t)).toBe(false)
    const status = wrapper.find('[data-test=drive-status]')
    expect(status.attributes('data-status')).toBe(statusAt(record.events, t).status)
    expect(status.attributes('data-status')).toBe(stop.status)
    // The live edge's status, from the same totals: what the rover is doing now.
    const edge = () => Math.min(playback!.liveTime.value, playback!.heldUntil.value)
    expect(edge()).toBeLessThan(stop.endsAt!)
    expect(playback!.liveStatus.value).toEqual({ status: stop.status })
    expect(wrapper.find('[data-test=odometer-segment]').text()).toContain(
      whole.at(t).actualM.toFixed(2),
    )
    // The fog lifts what the drive revealed from its start, from the traces alone.
    expect(track!.snapshot.value.reveals).toEqual(record.reveals.filter((r) => r.t <= t))
    expect(track!.driven.value[0]).toMatchObject({ x: record.start.x, y: record.start.y })

    const loaded = calls.length
    playback!.seek(40)
    await settle(() => expect(track!.snapshot.value.t).toBe(40))
    await settle(() => expect(playback!.keyframes.value?.data[0]).toBe(sliceSeconds))
    for (let k = 0; k < 10; k++) await nextFrame()
    expect(calls.slice(loaded).sort()).toEqual(range(1, opening).map(sliceUrl).sort())
    await settle(() =>
      expect(wrapper.find('[data-test=odometer-segment]').text()).toContain(
        whole.at(40).actualM.toFixed(2),
      ),
    )
    expect(wrapper.find('[data-test=drive-status]').attributes('data-status')).toBe(
      statusAt(record.events, 40).status,
    )
    // Playback went back; the live edge did not.
    expect(statusAt(record.events, 40).status).not.toBe(stop.status)
    expect(playback!.liveStatus.value).toEqual({ status: statusAt(record.events, edge()).status })
    expect(playback!.liveStatus.value?.status).toBe(stop.status)
    wrapper.unmount()
  }, 30_000)
})
