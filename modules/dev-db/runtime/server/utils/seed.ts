import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import {
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  revealedKey,
  worldHash,
} from '#shared/utils/terrain'
import { mission } from '#server/database/schema'
import { createMission, setCurrentStop } from '#server/repositories/missions'
import { openRound } from '#server/repositories/rounds'
import { createStop } from '#server/repositories/stops'
import { useDB } from '#server/utils/db'
import { publishStop } from '#server/utils/journey/publish'
import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'
import {
  assertLoopback,
  DatabaseRefusedError,
  databaseRefusal,
  resetLocalDatabase,
} from './migrate'

export interface SeedInput {
  store?: JourneyStore
  /** World seed; default `mars`. */
  seed?: string
  /** Stop 0, world metres; default the origin. */
  x?: number
  y?: number
  /** Reset the database first instead of refusing when it already has a mission. */
  force?: boolean
}

export interface SeededMission {
  missionId: string
  stopId: string
  roundId: string
  worldHash: string
  manifestKey: string
  skippedChunks: number
  /** Blobs written for stop 0: how many, their raw bytes and their bytes as stored. */
  bytes: { count: number; raw: number; stored: number }
}

/** Thrown when seeding a database that already has a mission without `force`. */
export class MissionExistsError extends Error {
  constructor(missionId: string) {
    super(
      `The local database already has a mission (${missionId}); seed with \`force: true\` to reset it first.`,
    )
    this.name = 'MissionExistsError'
  }
}

/**
 * Lands a mission: stop 0 published to the journey store, then the mission, its stop 0 (made
 * current) and an open round from it, in one transaction.
 */
export async function seedLocalMission(
  url: string | undefined,
  directory: string,
  input: SeedInput = {},
): Promise<SeededMission> {
  assertLoopback(url)
  const refusal = input.force ? await resetLocalDatabase(url, directory) : await databaseRefusal()
  if (refusal) throw new DatabaseRefusedError(refusal)

  const db = useDB()
  const [existing] = await db.select({ id: mission.id }).from(mission).limit(1)
  if (existing) throw new MissionExistsError(existing.id)

  const seed = input.seed ?? 'mars'
  const at = { x: input.x ?? 0, y: input.y ?? 0 }
  const world = defineWorld({ seed })
  const hash = worldHash(world)
  const disk = computeStopDisk(world, { center: at })
  const mask = revealDisk(createRevealedMask(world), disk)
  const published = await publishStop(input.store ?? createJourneyStore(), {
    world,
    disk,
    mask,
    stopIndex: 0,
  })

  const ids = await db.transaction(async (tx) => {
    const created = await createMission(tx, {
      seed,
      worldHash: hash,
      config: { world: {}, rules: DEFAULT_MISSION_RULES },
    })
    const stop = await createStop(tx, {
      missionId: created.id,
      index: 0,
      ...at,
      headingRad: 0,
      manifestKey: published.manifestKey,
      revealedKey: revealedKey(hash, 0),
    })
    const round = await openRound(tx, { missionId: created.id, fromStopId: stop.id })
    await setCurrentStop(tx, created.id, stop.id)
    return { missionId: created.id, stopId: stop.id, roundId: round.id }
  })

  return {
    ...ids,
    worldHash: hash,
    manifestKey: published.manifestKey,
    skippedChunks: published.skipped.length,
    bytes: {
      count: published.written.length,
      raw: published.written.reduce((n, w) => n + w.rawLength, 0),
      stored: published.written.reduce((n, w) => n + w.storedLength, 0),
    },
  }
}
