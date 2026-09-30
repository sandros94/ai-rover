import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  encodeTraceBlock,
  parseJourneyKey,
  parseStoredSegmentManifest,
  segmentTraceKey,
  sliceGate,
} from '#shared/utils/drive'
import type { JourneyFixture } from '../../../scripts/journey-fixture'
import { buildJourneyFixture, JOURNEY_FIXTURE } from '../../../scripts/journey-fixture'

export { JOURNEY_FIXTURE }

const RECORDS = new URL('../../fixtures/records/', import.meta.url)

let fixture: JourneyFixture | undefined
/** The fixture journey rebuilt in memory, record included; built once per test file. */
export function journeyFixture(): JourneyFixture {
  fixture ??= buildJourneyFixture()
  return fixture
}

/** The bytes of a recorded journey key, or undefined when no such file exists. */
export function readRecord(key: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(fileURLToPath(new URL(key, RECORDS))))
  } catch {
    return undefined
  }
}

/**
 * A `fetch` serving `test/fixtures/records/` the way `/journey/{key}` does, already inflated:
 * unknown keys and unreleased slices, traces and trace blocks (at `now()`, epoch ms, counted from
 * `startedAt`, the segment row's start) answer 404, the latter with `x-release-at`. `override`
 * answers first when it returns a response for a key. Every requested URL is appended to `calls`.
 */
export function recordsFetch(
  options: {
    now?: () => number
    startedAt?: number
    override?: (key: string) => Response | undefined
  } = {},
): { fetch: (input: string) => Promise<Response>; calls: string[] } {
  const {
    now = () => Number.MAX_SAFE_INTEGER,
    startedAt = JOURNEY_FIXTURE.startedAt,
    override,
  } = options
  const calls: string[] = []
  const notFound = (headers: Record<string, string> = {}) =>
    new Response(null, { status: 404, headers })
  async function fetch(input: string): Promise<Response> {
    calls.push(input)
    const key = input.replace(/^\/journey\//, '')
    const custom = override?.(key)
    if (custom) return custom
    const parsed = parseJourneyKey(key)
    if (!parsed) return notFound()
    if (parsed.kind !== 'terrain' && parsed.kind !== 'stop' && parsed.kind !== 'segment-manifest') {
      const manifest = readRecord(`segments/${parsed.segmentId}/manifest.json`)
      if (!manifest) return notFound()
      const stored = parseStoredSegmentManifest(JSON.parse(new TextDecoder().decode(manifest)))
      const last = parsed.kind === 'segment-trace-block' ? parsed.to : parsed.index
      const gate = sliceGate({ startedAt, sliceSeconds: stored.sliceSeconds }, last, now())
      if (!gate.released) {
        return notFound({ 'x-release-at': new Date(gate.releaseAt).toISOString() })
      }
    }
    const bytes =
      parsed.kind === 'segment-trace-block'
        ? traceBlock(parsed.segmentId, parsed.from, parsed.to)
        : readRecord(key)
    if (!bytes) return notFound()
    const type = key.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': type } })
  }
  return { fetch, calls }
}

/** Traces `from … to` as the journey route assembles them, or undefined when one is missing. */
function traceBlock(segmentId: string, from: number, to: number): Uint8Array | undefined {
  const traces = Array.from({ length: to - from + 1 }, (_, k) =>
    readRecord(segmentTraceKey(segmentId, from + k)),
  )
  return traces.every(Boolean) ? encodeTraceBlock(traces as Uint8Array[]) : undefined
}
