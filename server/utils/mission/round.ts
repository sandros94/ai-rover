import type { DB } from '../../database/db'
import type { Mission, Round } from '../../database/schema'
import { setNextDueAt } from '../../repositories/missions'
import { getOpenRound } from '../../repositories/rounds'
import { getDrivingSegment, getLatestSegment } from '../../repositories/segments'
import type { ListedSubmission } from '../../repositories/submissions'
import { getSubmission, listRoundSubmissions } from '../../repositories/submissions'
import type { MissionRules } from '#shared/utils/mission'
import { roundCloseAt } from '#shared/utils/mission'

/**
 * An open round's open submissions (creation order), when it closes, per `roundCloseAt`, and who
 * wrote the drive it was opened beside. The drive before it is the latest segment started no
 * later than the round opened; it was opened beside that drive when both began at the same
 * instant, since a round opens in the same step that starts that drive (a round opened after a
 * failure or a void round has no drive beside it).
 */
export async function roundStanding(
  db: DB,
  round: Round,
  options: { rules: MissionRules; now: Date },
): Promise<{
  submissions: ListedSubmission[]
  closesAt: Date | null
  /** Ranks last in this round: see `rankSubmissions`. */
  drivingAuthorId: string | null
}> {
  const submissions = (await listRoundSubmissions(db, round.id)).filter((s) => s.status === 'open')
  const latest = await getLatestSegment(db, round.missionId)
  const before = latest && latest.startedAt.getTime() <= round.opensAt.getTime() ? latest : null
  const closesAt = roundCloseAt({
    driveEndsAt: before?.endsAt ?? null,
    firstSubmissionAt: submissions[0]?.createdAt ?? null,
    now: options.now,
    rules: options.rules,
  })
  const beside = before && before.startedAt.getTime() === round.opensAt.getTime() ? before : null
  const drivingAuthorId = beside ? (await getSubmission(db, beside.submissionId)).userId : null
  return { submissions, closesAt, drivingAuthorId }
}

/**
 * Records on the mission when a tick next has something to do: the end of the drive in progress
 * (its settlement) or the open round's close, whichever comes first; null when neither is
 * pending. A round closes no later than the drive beside it ends, so while one plays that end is
 * the instant.
 */
export async function recordNextDue(
  db: DB,
  mission: Pick<Mission, 'id' | 'config'>,
  now: Date,
): Promise<Date | null> {
  const driving = await getDrivingSegment(db, mission.id)
  const open = await getOpenRound(db, mission.id)
  const closesAt = open
    ? (await roundStanding(db, open, { rules: mission.config.rules, now })).closesAt
    : null
  const pending = [driving?.endsAt, closesAt].filter((at): at is Date => at instanceof Date)
  const due = pending.length > 0 ? new Date(Math.min(...pending.map((at) => at.getTime()))) : null
  await setNextDueAt(db, mission.id, due)
  return due
}
