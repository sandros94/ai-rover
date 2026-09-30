import { uuidv7 } from 'unsecure/uuid'
import type { DB } from '../../database/db'
import type { Mission, Round, Stop } from '../../database/schema'
import { createMission, setCurrentStop } from '../../repositories/missions'
import { openRound } from '../../repositories/rounds'
import { createStop } from '../../repositories/stops'
import { primeStop } from '../journey/prime'
import { publishStop } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import type { MissionRules } from '#shared/utils/mission'
import { DEFAULT_MISSION_RULES, landingMask } from '#shared/utils/mission'
import type { WorldConfig } from '#shared/utils/terrain'
import { computeStopDisk, createRevealedMask, defineWorld, worldHash } from '#shared/utils/terrain'

export interface NewMissionAtStop {
  store: JourneyStore
  /** World seed. */
  seed: string
  /** The landing stop, world metres. */
  at: { x: number; y: number }
  /** World overrides stored with the mission; default none. */
  world?: Omit<WorldConfig, 'seed'>
  /** Default {@link DEFAULT_MISSION_RULES}. */
  rules?: MissionRules
  /** Mission start (the sol clock's zero) and the opening of round 0. Default: now. */
  now?: Date
}

export interface MissionAtStop {
  mission: Mission
  stop: Stop
  round: Round
  published: Awaited<ReturnType<typeof publishStop>>
}

/**
 * Lands a mission: publishes stop 0 (its disk, the viewshed from it as the first revealed mask,
 * its manifest), then creates the mission, stop 0 made current and round 0 open from it and
 * anchored on it, in one transaction. Blobs go first so a stop row never names a blob that is not
 * there; once the rows are written the stop is primed in the CDN, without waiting for it.
 */
export async function createMissionAtStop(db: DB, input: NewMissionAtStop): Promise<MissionAtStop> {
  const { store, seed, at, now = new Date() } = input
  const config = { world: input.world ?? {}, rules: input.rules ?? DEFAULT_MISSION_RULES }
  const world = defineWorld({ seed, ...config.world })
  const hash = worldHash(world)
  const disk = computeStopDisk(world, { center: at, radius: config.rules.stopRadiusM })
  const mask = landingMask(createRevealedMask(world), disk)
  const missionId = uuidv7()
  const published = await publishStop(store, { world, disk, mask, missionId, reachedBy: null })

  const landed = await db.transaction(async (tx) => {
    await createMission(tx, {
      id: missionId,
      seed,
      worldHash: hash,
      config,
      solsEpoch: now,
    })
    const stop = await createStop(tx, {
      missionId,
      index: 0,
      x: at.x,
      y: at.y,
      headingRad: 0,
      manifestKey: published.keys.manifestKey,
      revealedKey: published.keys.revealedKey,
    })
    const round = await openRound(tx, {
      missionId,
      fromStopId: stop.id,
      anchor: at,
      opensAt: now,
    })
    const mission = await setCurrentStop(tx, missionId, stop.id)
    return { mission, stop, round, published }
  })
  void primeStop(published.keys)
  return landed
}
