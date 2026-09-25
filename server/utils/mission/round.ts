import type { DB } from '../../database/db'
import type { Round } from '../../database/schema'
import { getLatestSegment } from '../../repositories/segments'
import type { ListedSubmission } from '../../repositories/submissions'
import { listRoundSubmissions } from '../../repositories/submissions'
import type { MissionRules } from '#shared/utils/mission'
import { roundCloseAt } from '#shared/utils/mission'

/**
 * An open round's open submissions (creation order) and when it closes, per `roundCloseAt`: the
 * drive it runs beside is the latest segment started no later than the round opened, since a
 * round opens in the same step that starts that drive.
 */
export async function roundStanding(
  db: DB,
  round: Round,
  options: { rules: MissionRules; now: Date },
): Promise<{ submissions: ListedSubmission[]; closesAt: Date | null }> {
  const submissions = (await listRoundSubmissions(db, round.id)).filter((s) => s.status === 'open')
  const latest = await getLatestSegment(db, round.missionId)
  const driveEndsAt =
    latest && latest.startedAt.getTime() <= round.opensAt.getTime() ? latest.endsAt : null
  const closesAt = roundCloseAt({
    driveEndsAt,
    firstSubmissionAt: submissions[0]?.createdAt ?? null,
    now: options.now,
    rules: options.rules,
  })
  return { submissions, closesAt }
}
