// TODO(dev-only): publishing smoke endpoint for the journey store; removed before launch.
import { defineHandler, HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { DriveError, driveSegment, SEGMENT_ID } from '#shared/utils/drive'
import {
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  TerrainError,
} from '#shared/utils/terrain'
import { publishSegment, publishStop } from '../../utils/journey/publish'
import type { PutResult } from '../../utils/journey/store'
import { createJourneyStore } from '../../utils/journey/store'

const finite = v.pipe(v.number(), v.finite())

const BodySchema = v.object({
  seed: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  goal: v.object({ x: finite, y: finite }),
  segmentId: v.pipe(v.string(), v.regex(SEGMENT_ID)),
  startedAtOffsetS: v.optional(finite, 0),
})

/**
 * Stop 0 at the origin of world `seed` and one segment from there to `goal`, published to the
 * journey store with `startedAt = now + startedAtOffsetS`.
 */
export default defineHandler(async (event) => {
  if (!import.meta.dev) throw HTTPError.status(404)

  const body = await readValidatedBody(event, BodySchema, {
    onError: (result) => ({
      status: 400,
      message: result.issues
        .map(
          (issue) =>
            `${issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') ?? 'body'}: ${issue.message}`,
        )
        .join('; '),
    }),
  })

  const timings: Record<string, number> = {}
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const began = performance.now()
    const result = await fn()
    timings[name] = Math.round(performance.now() - began)
    return result
  }

  const store = createJourneyStore()
  const start = { x: 0, y: 0, headingRad: 0 }
  try {
    const world = defineWorld({ seed: body.seed })
    const disk = await time('diskMs', () => computeStopDisk(world, { center: start }))
    const mask = revealDisk(createRevealedMask(world), disk)
    const { record } = await time('driveMs', () =>
      driveSegment(world, { disk, revealed: mask, start, goal: body.goal }),
    )
    const stop = await time('publishStopMs', () =>
      publishStop(store, { world, disk, mask, stopIndex: 0 }),
    )
    const startedAt = Math.round(Date.now() + body.startedAtOffsetS * 1000)
    const segment = await time('publishSegmentMs', () =>
      publishSegment(store, { record, segmentId: body.segmentId, startedAt }),
    )
    const chunks = stop.written.filter((w) => w.key.includes('/chunks/'))
    const maskBlobs = stop.written.filter((w) => w.key.includes('/revealed/'))
    const slices = segment.written.filter((w) => w.key.includes('/slices/'))
    return {
      stopManifestKey: stop.manifestKey,
      segmentManifestKey: segment.manifestKey,
      startedAt: new Date(startedAt).toISOString(),
      durationS: record.outcome.durationS,
      skippedChunks: stop.skipped.length,
      keys: [...stop.written, ...segment.written].map((w) => w.key),
      bytes: {
        chunks: totals(chunks),
        mask: totals(maskBlobs),
        slices: totals(slices),
        manifests: totals([stop.written.at(-1)!, segment.written.at(-1)!]),
      },
      timings,
    }
  } catch (error) {
    if (error instanceof TerrainError || error instanceof DriveError) {
      throw new HTTPError(error.message, { status: 400 })
    }
    throw error
  }
})

function totals(written: PutResult[]) {
  const raw = written.reduce((n, w) => n + w.rawLength, 0)
  const stored = written.reduce((n, w) => n + w.storedLength, 0)
  return {
    count: written.length,
    raw,
    deflated: stored,
    ratio: raw ? +(stored / raw).toFixed(3) : 0,
  }
}
