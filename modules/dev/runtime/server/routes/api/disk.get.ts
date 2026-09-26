import { defineHandler, getValidatedQuery, HTTPError } from 'nitro/h3'
import * as v from 'valibot'
import type { StopDisk } from '#shared/utils/terrain'
import { computeStopDisk, defineWorld, TerrainError } from '#shared/utils/terrain'
import { encodeDiskWire } from '../../../shared/disk-wire'

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

/** The stop disk of world `seed` around (x, y), in the viewer's binary layout (`disk-wire`). */
export default defineHandler(async (event) => {
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

  return new Response(encodeDiskWire(disk), {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-compute-ms': computeMs.toFixed(1),
    },
  })
})
