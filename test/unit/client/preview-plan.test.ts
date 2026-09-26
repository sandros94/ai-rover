import { describe, expect, it } from 'vitest'
import { checkPathClearOfDeaths, DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionRules } from '#shared/utils/mission'
import { EFFECTIVE_SPEED_MPS, planSegment } from '#shared/utils/nav'
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
    const goal = snapToPathable(fixture.disk, point)!
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
    expect(result.estimatedMinutes).toBe(
      Math.round(server.metrics.pathLengthM / EFFECTIVE_SPEED_MPS / 60),
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
      goal: snapToPathable(fixture.disk, point),
    })
  })

  it('refuses a point with no pathable ground within reach', () => {
    expect(previewPlan(ground.disk, { ...base, point: { x: 200, y: 200 } })).toEqual({
      ok: false,
      reason: 'unpathable',
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
