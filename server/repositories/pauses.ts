import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError, isUniqueViolation } from '../database/errors'
import { missionPause, userAccount } from '../database/schema'

/** A mission's pause as shown to everyone. */
export interface ActivePause {
  message: string
  at: Date
  by: { id: string; displayName: string; avatarUrl: string | null }
}

/** The mission's pause not yet resumed, if any. */
export async function getActivePause(db: DB, missionId: string): Promise<ActivePause | undefined> {
  const [row] = await db
    .select({
      message: missionPause.message,
      at: missionPause.pausedAt,
      by: {
        id: userAccount.id,
        displayName: userAccount.displayName,
        avatarUrl: userAccount.avatarUrl,
      },
    })
    .from(missionPause)
    .innerJoin(userAccount, eq(userAccount.id, missionPause.pausedBy))
    .where(and(eq(missionPause.missionId, missionId), isNull(missionPause.resumedAt)))
    .orderBy(desc(missionPause.pausedAt))
    .limit(1)
  return row
}

/** Pauses the mission with `message`; refused while it is already paused. */
export async function pauseMission(
  db: DB,
  missionId: string,
  options: { message: string; pausedBy: string; at?: Date },
): Promise<void> {
  const { message, pausedBy, at } = options
  try {
    await db.transaction((sp) =>
      sp.insert(missionPause).values({ missionId, message, pausedBy, pausedAt: at }),
    )
  } catch (error) {
    if (!isUniqueViolation(error, 'mission_pause_active_idx')) throw error
    throw new DbError(
      'INVALID_STATE',
      `Mission ${missionId} is already paused; resume it before pausing again.`,
      { cause: error },
    )
  }
}

/** Ends the mission's active pause at `at`; refused when it is not paused. */
export async function resumeMission(
  db: DB,
  missionId: string,
  options: { at: Date },
): Promise<void> {
  const [row] = await db
    .update(missionPause)
    .set({ resumedAt: options.at })
    .where(and(eq(missionPause.missionId, missionId), isNull(missionPause.resumedAt)))
    .returning({ id: missionPause.id })
  if (!row) {
    throw new DbError('INVALID_STATE', `Mission ${missionId} is not paused; nothing to resume.`)
  }
}
