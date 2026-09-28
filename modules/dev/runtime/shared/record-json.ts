import { base64Parse, base64Stringify } from 'unsecure/utils'
import type { SegmentRecord } from '#shared/utils/drive'
import { decodeKeyframes, encodeKeyframes } from '#shared/utils/drive'

/**
 * A `SegmentRecord` that survives `JSON.stringify`: the keyframes as base64 of their
 * `encodeKeyframes` bytes, each reveal's vertex indices as base64 of little-endian u32.
 * Everything else is plain.
 */
export interface SegmentRecordJson extends Omit<SegmentRecord, 'keyframes' | 'reveals'> {
  keyframes: string
  reveals: { t: number; vertices: string }[]
}

export function recordToJson(record: SegmentRecord): SegmentRecordJson {
  return {
    ...record,
    keyframes: base64Stringify(encodeKeyframes(record.keyframes)),
    reveals: record.reveals.map(({ t, vertices }) => ({ t, vertices: encodeU32(vertices) })),
  }
}

export function jsonToRecord(json: SegmentRecordJson): SegmentRecord {
  return {
    ...json,
    keyframes: decodeKeyframes(base64Parse(json.keyframes, { returnAs: 'bytes' })),
    reveals: json.reveals.map(({ t, vertices }) => ({ t, vertices: decodeU32(vertices) })),
  }
}

// Typed-array bytes are in host order; the text form is fixed little-endian.
function encodeU32(values: Uint32Array): string {
  const view = new DataView(new ArrayBuffer(values.length * 4))
  for (let k = 0; k < values.length; k++) view.setUint32(k * 4, values[k]!, true)
  return base64Stringify(new Uint8Array(view.buffer))
}

function decodeU32(text: string): Uint32Array {
  const bytes = base64Parse(text, { returnAs: 'bytes' })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const values = new Uint32Array(bytes.byteLength / 4)
  for (let k = 0; k < values.length; k++) values[k] = view.getUint32(k * 4, true)
  return values
}
