// TODO(dev-only): terrain-tuning endpoint for `/_dev/disk`; removed before launch.
import { defineHandler, getValidatedQuery, HTTPError } from 'nitro/h3'
import * as v from 'valibot'

/** Header before the arrays: u32 width, u32 height, f32 cellSize, i32 originI, i32 originJ, f32 centerX, f32 centerY. */
const HEADER_BYTES = 28

const FLAG_TRAVERSABLE = 1
const FLAG_REACHABLE = 2
const FLAG_VISIBLE = 4

const number = v.pipe(v.string(), v.toNumber(), v.finite())

const QuerySchema = v.object({
  seed: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128)), 'mars'),
  x: v.optional(number, '0'),
  y: v.optional(number, '0'),
  radius: v.optional(
    v.pipe(
      number,
      v.transform((r) => Math.min(800, Math.max(50, r))),
    ),
    '500',
  ),
  amplitude: v.optional(v.pipe(number, v.minValue(0))),
  gain: v.optional(v.pipe(number, v.gtValue(0))),
  craters: v.optional(v.pipe(number, v.minValue(0))),
})

export default defineHandler(async (event) => {
  if (!import.meta.dev) throw HTTPError.status(404)

  const query = await getValidatedQuery(event, QuerySchema, {
    onError: (result) => ({
      status: 400,
      message: result.issues
        .map(
          (issue) =>
            `${issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') ?? 'query'}: ${issue.message}`,
        )
        .join('; '),
    }),
  })

  const started = performance.now()
  let disk: StopDisk
  try {
    const world = defineWorld({
      seed: query.seed,
      relief: {
        ...(query.amplitude === undefined ? {} : { amplitude: query.amplitude }),
        ...(query.gain === undefined ? {} : { gain: query.gain }),
      },
      craters: query.craters === undefined ? {} : { meanPerCell: query.craters },
    })
    disk = computeStopDisk(world, { center: { x: query.x, y: query.y }, radius: query.radius })
  } catch (error) {
    if (error instanceof TerrainError) throw new HTTPError(error.message, { status: 400 })
    throw error
  }
  const computeMs = performance.now() - started

  const { width, height, cellSize, heights } = disk.grid
  const count = width * height
  const body = new ArrayBuffer(HEADER_BYTES + count * 5)
  const view = new DataView(body)
  view.setUint32(0, width, true)
  view.setUint32(4, height, true)
  view.setFloat32(8, cellSize, true)
  view.setInt32(12, disk.origin.i, true)
  view.setInt32(16, disk.origin.j, true)
  view.setFloat32(20, disk.center.x, true)
  view.setFloat32(24, disk.center.y, true)
  // Float32Array views use host byte order; the wire format is little-endian, so write through the view.
  for (let k = 0; k < count; k++) view.setFloat32(HEADER_BYTES + k * 4, heights[k]!, true)
  const flags = new Uint8Array(body, HEADER_BYTES + count * 4, count)
  for (let k = 0; k < count; k++) {
    flags[k] =
      (disk.traversable[k] ? FLAG_TRAVERSABLE : 0) |
      (disk.reachable[k] ? FLAG_REACHABLE : 0) |
      (disk.visible[k] ? FLAG_VISIBLE : 0)
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-compute-ms': computeMs.toFixed(1),
    },
  })
})
