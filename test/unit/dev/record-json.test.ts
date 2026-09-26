import { describe, expect, it } from 'vitest'
import { driveSegment } from '#shared/utils/drive'
import { computeStopDisk, defineWorld } from '#shared/utils/terrain'
import { jsonToRecord, recordToJson } from '~~/modules/dev/runtime/shared/record-json'
import { revealedAfterStop } from '../drive/helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 200 })
const { record } = driveSegment(world, {
  disk,
  revealed: revealedAfterStop(world, disk),
  start: { x: 0, y: 0, headingRad: 0 },
  goal: { x: 40, y: 30 },
})

describe('recordToJson', () => {
  const json = recordToJson(record)

  it('carries binary blocks as base64 strings', () => {
    expect(typeof json.keyframes).toBe('string')
    expect(json.reveals.length).toBe(record.reveals.length)
    for (const reveal of json.reveals) expect(typeof reveal.vertices).toBe('string')
    expect(json.plan.polyline).toEqual(record.plan.polyline)
    expect(json.outcome).toEqual(record.outcome)
  })

  it('round-trips a real record exactly through JSON text', () => {
    const back = jsonToRecord(JSON.parse(JSON.stringify(json)))
    expect(back).toEqual(record)
    expect(back.keyframes.data).toBeInstanceOf(Float32Array)
    expect(new Uint8Array(back.keyframes.data.buffer)).toEqual(
      new Uint8Array(record.keyframes.data.buffer),
    )
    for (const [k, reveal] of back.reveals.entries()) {
      expect(reveal.vertices).toBeInstanceOf(Uint32Array)
      expect(reveal.vertices).toEqual(record.reveals[k]!.vertices)
    }
  })
})
