import { describe, expect, it } from 'vitest'
import {
  checkPathClearOfDeaths,
  DEFAULT_MISSION_RULES,
  formatDriveTime,
  planGoal,
} from '#shared/utils/mission'
import type { MissionRules } from '#shared/utils/mission'

import { planSegment } from '#shared/utils/nav'
import { AUTONAV_EFFECTIVE_MPS } from '#shared/utils/rover'
import type { StopDisk } from '#shared/utils/terrain'
import { revealedOverDisk, snapToPathable } from '#shared/utils/terrain'
import {
  createChunkCache,
  createJourneyClient,
  createTerrainSampler,
  diskFromTerrain,
  previewPlan,
} from '#shared/utils/client'
import { JOURNEY_FIXTURE, journeyFixture, recordsFetch } from './helpers'

const fixture = journeyFixture()
const { missionId, stopIndex } = JOURNEY_FIXTURE

/** The disk and revealed bytes as the browser builds them: from the served blobs only. */
async function clientGround(): Promise<{ disk: StopDisk; revealed: Uint8Array }> {
  const client = createJourneyClient({ fetch: recordsFetch().fetch })
  const manifest = await client.getStopManifest(missionId, stopIndex)
  const mask = await client.getRevealedMask(missionId, stopIndex)
  const cache = createChunkCache({ client, worldHash: manifest.worldHash })
  await cache.prefetch(manifest.chunks)
  const terrain = createTerrainSampler(cache).assembleDiskGrid(manifest)!
  const disk = diskFromTerrain(terrain, manifest)
  return { disk, revealed: revealedOverDisk(mask, disk) }
}

const ground = await clientGround()
const serverRevealed = revealedOverDisk(fixture.mask, fixture.disk)
const anchor = { x: 0, y: 0 }
const rules = DEFAULT_MISSION_RULES
const slopeLimitDeg = fixture.world.config.slopeLimitDeg
const base = { revealed: ground.revealed, anchor, deaths: [], rules, slopeLimitDeg }

/** Where the server snaps `point`, or undefined when it refuses it. */
function serverSnap(point: { x: number; y: number }) {
  const snapped = snapToPathable(fixture.disk, point, { revealed: serverRevealed })
  return snapped.ok ? snapped.point : undefined
}

describe('diskFromTerrain', () => {
  it('rebuilds the server stop disk exactly from the served chunks', () => {
    const { disk } = ground
    expect(disk.center).toEqual(fixture.disk.center)
    expect(disk.radius).toBe(fixture.disk.radius)
    expect(disk.chunks).toEqual(fixture.disk.chunks)
    expect(disk.origin).toEqual(fixture.disk.origin)
    expect(disk.grid).toEqual(fixture.disk.grid)
    expect(disk.traversable).toEqual(fixture.disk.traversable)
    expect(disk.visible).toEqual(fixture.disk.visible)
    expect(ground.revealed).toEqual(serverRevealed)
  })
})

describe('previewPlan on the recorded journey', () => {
  const point = { x: 40.3, y: 34.6 }

  it('snaps the point and plans exactly as the server does', () => {
    const result = previewPlan(ground.disk, { ...base, point })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const goal = serverSnap(point)!
    expect(result.goal).toEqual(goal)
    const server = planSegment(fixture.disk, {
      revealed: serverRevealed,
      start: anchor,
      goal,
      slopeLimitDeg,
    })
    expect(JSON.stringify(result.polyline)).toBe(JSON.stringify(server.polyline))
    expect({ ...result.metrics, computeMs: 0 }).toEqual({ ...server.metrics, computeMs: 0 })
    expect(result.metrics.reached).toBe(true)
    // Slopes slow the rover and imaging stops it: longer than the path at the AutoNav rate.
    expect(result.metrics.estimatedDriveS).toBeGreaterThan(
      server.metrics.pathLengthM / AUTONAV_EFFECTIVE_MPS,
    )
  })

  it('reports the steepest seen slope of every polyline segment', () => {
    const result = previewPlan(ground.disk, { ...base, point })
    if (!result.ok) throw new Error('expected a plan')
    expect(result.segmentSlopes).toHaveLength(result.polyline.length - 1)
    const seen = result.segmentSlopes.filter((s): s is number => s !== null)
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeCloseTo(result.metrics.maxSlopeDeg, 9)
  })

  it('refuses a drive planned too short or too long, saying how long it would take', () => {
    // 11 m from the anchor: a few minutes of driving.
    const short = previewPlan(ground.disk, { ...base, point: { x: 10, y: 5 } })
    expect(short).toMatchObject({ ok: false, reason: 'too-short', goal: { x: 10, y: 5 } })
    expect(!short.ok && short.message).toMatch(
      /^The planned drive takes about \d+ min; a segment drives at least 15 min\.$/,
    )
    const planned = previewPlan(ground.disk, { ...base, point })
    if (!planned.ok) throw new Error('expected a plan')
    const tight: MissionRules = {
      ...rules,
      segmentTimeBand: { minS: 60, maxS: planned.metrics.estimatedDriveS - 1 },
    }
    const long = previewPlan(ground.disk, { ...base, rules: tight, point })
    expect(long).toMatchObject({ ok: false, reason: 'too-long', goal: serverSnap(point) })
    expect(!long.ok && long.message).toContain(formatDriveTime(planned.metrics.estimatedDriveS))
  })

  it('refuses a point beyond the survey as outside, as the server does', () => {
    const beyond = { x: 36, y: 48.1 }
    expect(Math.hypot(beyond.x, beyond.y)).toBeGreaterThan(fixture.disk.radius)
    const outside = { ok: false, reason: 'outside' }
    expect(previewPlan(ground.disk, { ...base, point: beyond })).toEqual(outside)
    expect(snapToPathable(fixture.disk, beyond, { revealed: serverRevealed })).toEqual(outside)
    // A goal submitted from another stop, planned over this one, is refused rather than thrown.
    expect(planGoal(fixture.disk, { ...base, start: anchor, goal: beyond })).toEqual(outside)
  })

  /** A vertex inside the ring whose snap neighbourhood is all unseen, pathable or not. */
  function foggedVertex(): { x: number; y: number } {
    const { disk } = ground
    const { width } = disk.grid
    const vertex = (x: number, y: number) => (y - disk.origin.j) * width + (x - disk.origin.i)
    for (let r = 20; r <= 58; r += 2) {
      for (let a = 0; a < 360; a += 5) {
        const x = Math.round(r * Math.cos((a * Math.PI) / 180))
        const y = Math.round(r * Math.sin((a * Math.PI) / 180))
        let seen = false
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) if (ground.revealed[vertex(x + dx, y + dy)]) seen = true
        if (!seen && Math.hypot(x, y) <= 57) return { x, y }
      }
    }
    throw new Error('no fogged vertex in the recorded disk')
  }
  const fogged = foggedVertex()
  const near = { ...rules, segmentTimeBand: { minS: 0, maxS: 7200 } }

  it('takes a point on unseen ground at the vertex picked and plans to it, as the server does', () => {
    const point = { x: fogged.x + 0.3, y: fogged.y - 0.2 }
    const result = previewPlan(ground.disk, { ...base, rules: near, point })
    expect(result).toMatchObject({ ok: true, goal: fogged })
    if (!result.ok) return
    expect(serverSnap(point)).toEqual(fogged)
    expect(result.metrics.reached).toBe(true)
    expect(result.metrics.goalInFog).toBe(true)
    expect(result.metrics.unrevealedFraction).toBeGreaterThan(0)
    const seenGoal = previewPlan(ground.disk, { ...base, point: { x: 40.3, y: 34.6 } })
    expect(seenGoal.ok && seenGoal.metrics.goalInFog).toBe(false)
  })

  it('decides alike whatever the fog around the goal hides', () => {
    // Unseen ground two or more vertices from any seen vertex made a wall of impassable spikes.
    const { disk } = ground
    const { width, height } = disk.grid
    const heights = disk.grid.heights.slice()
    const traversable = disk.traversable.slice()
    let hidden = 0
    for (let j = 2; j < height - 2; j++) {
      for (let i = 2; i < width - 2; i++) {
        let seenNear = false
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++)
            if (ground.revealed[(j + dj) * width + i + di]) seenNear = true
        if (seenNear) continue
        const k = j * width + i
        heights[k] = (i + j) % 2 === 0 ? 40 : -40
        traversable[k] = 0
        hidden++
      }
    }
    expect(hidden).toBeGreaterThan(0)
    const spiked = { ...disk, grid: { ...disk.grid, heights }, traversable }
    const point = { x: fogged.x + 0.3, y: fogged.y - 0.2 }
    const strip = (r: ReturnType<typeof previewPlan>) =>
      r.ok ? { ...r, metrics: { ...r.metrics, computeMs: 0 } } : r
    for (const context of [
      { ...base, rules: near, point },
      { ...base, rules: near, point, deaths: [{ x: fogged.x + 10, y: fogged.y }] },
      { ...base, point },
    ]) {
      expect(strip(previewPlan(spiked, context))).toEqual(strip(previewPlan(disk, context)))
    }
  })

  it('refuses a goal near a death, and a route passing near one', () => {
    const near = previewPlan(ground.disk, { ...base, point, deaths: [{ x: 45, y: 30 }] })
    expect(near).toMatchObject({ ok: false, reason: 'near-death-zone' })
    const plan = previewPlan(ground.disk, { ...base, point })
    if (!plan.ok) throw new Error('expected a plan')
    const death = { x: 6, y: 4 }
    expect(checkPathClearOfDeaths(plan.polyline, { deaths: [death], rules }).ok).toBe(false)
    expect(previewPlan(ground.disk, { ...base, point, deaths: [death] })).toMatchObject({
      ok: false,
      reason: 'path-near-death-zone',
    })
  })
})
