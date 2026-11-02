import { mission } from '#server/database/schema'
import { useDB } from '#server/utils/db'
import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'
import { createMissionAtStop } from '#server/utils/mission/create'
import { assertLoopback } from './loopback'

export interface SeedInput {
  store?: JourneyStore
  /** World seed; default `mars`. */
  seed?: string
  /** Stop 0, world metres; default the origin. */
  x?: number
  y?: number
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

/** Thrown when seeding a database that already has a mission. */
export class MissionExistsError extends Error {
  constructor(missionId: string) {
    super(
      `The local database already has a mission (${missionId}); run "Reset database" from the PGlite tab in Nuxt DevTools, then seed again.`,
    )
    this.name = 'MissionExistsError'
  }
}

/**
 * Lands a mission on an empty local database through the lifecycle's own landing. Refuses,
 * writing nothing, unless `url` (the database `useDB()` reaches) is on this machine.
 */
export async function seedLocalMission(
  url: string | undefined,
  input: SeedInput = {},
): Promise<SeededMission> {
  assertLoopback(url)
  const db = useDB()
  const [existing] = await db.select({ id: mission.id }).from(mission).limit(1)
  if (existing) throw new MissionExistsError(existing.id)

  const {
    mission: created,
    stop,
    round,
    published,
  } = await createMissionAtStop(db, {
    store: input.store ?? createJourneyStore(),
    seed: input.seed ?? 'mars',
    at: { x: input.x ?? 0, y: input.y ?? 0 },
  })

  return {
    missionId: created.id,
    stopId: stop.id,
    roundId: round.id,
    worldHash: created.worldHash,
    manifestKey: published.keys.manifestKey,
    skippedChunks: published.skipped.length,
    bytes: {
      count: published.written.length,
      raw: published.written.reduce((n, w) => n + w.rawLength, 0),
      stored: published.written.reduce((n, w) => n + w.storedLength, 0),
    },
  }
}
