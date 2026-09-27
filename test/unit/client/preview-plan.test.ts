import { describe, expect, it } from 'vitest'
import { checkPathClearOfDeaths, DEFAULT_MISSION_RULES, planGoal } from '#shared/utils/mission'
import type { MissionRules } from '#shared/utils/mission'
import { estimatedDriveMinutes } from '#shared/utils/drive'
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
    expect(disk.reachableFrom).toEqual(fixture.disk.reachableFrom)
    expect(disk.grid).toEqual(fixture.disk.grid)
    expect(disk.traversable).toEqual(fixture.disk.traversable)
    expect(disk.reachable).toEqual(fixture.disk.reachable)
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
    expect(result.estimatedMinutes).toBe(estimatedDriveMinutes(server))
    expect(result.estimatedMinutes).toBeGreaterThan(
      Math.round(server.metrics.pathLengthM / AUTONAV_EFFECTIVE_MPS / 60),
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

  it('refuses a goal too near or too far from the anchor, measured after snapping', () => {
    expect(previewPlan(ground.disk, { ...base, point: { x: 10, y: 5 } })).toMatchObject({
      ok: false,
      reason: 'too-near',
    })
    const tight: MissionRules = { ...rules, segmentDistanceBand: { minM: 10, maxM: 40 } }
    const far = previewPlan(ground.disk, { ...base, rules: tight, point })
    expect(far).toMatchObject({
      ok: false,
      reason: 'too-far',
      goal: serverSnap(point),
    })
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

  it('refuses a point on unseen ground as unrevealed, as the server does', () => {
    const { disk } = ground
    const { width } = disk.grid
    const vertex = (x: number, y: number) => (y - disk.origin.j) * width + (x - disk.origin.i)
    // A point inside the ring whose whole snap neighbourhood is unseen yet pathable ground.
    let fogged: { x: number; y: number } | undefined
    for (let r = 60; r <= 240 && !fogged; r += 5) {
      for (let a = 0; a < 360 && !fogged; a += 5) {
        const x = Math.round(r * Math.cos((a * Math.PI) / 180))
        const y = Math.round(r * Math.sin((a * Math.PI) / 180))
        let seen = false
        let pathable = false
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            if (Math.hypot(dx, dy) > 5) continue
            const k = vertex(x + dx, y + dy)
            if (ground.revealed[k]) seen = true
            if (disk.traversable[k] && disk.reachable[k]) pathable = true
          }
        }
        if (!seen && pathable) fogged = { x, y }
      }
    }
    expect(fogged).toBeDefined()
    expect(previewPlan(disk, { ...base, point: fogged! })).toEqual({
      ok: false,
      reason: 'unrevealed',
    })
    expect(snapToPathable(fixture.disk, fogged!, { revealed: serverRevealed })).toEqual({
      ok: false,
      reason: 'unrevealed',
    })
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
