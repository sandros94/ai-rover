import { noul, score } from '@typesafe-ai/sdk'

/**
 * The four questions asked about every submission, over a `SubmissionSummary` state. Levels
 * describe situations in the summary's own labels, never numbers: Jev matches descriptions and is
 * unreliable at comparing values. Changing any wording changes the request hash, so the recorded
 * fixtures must be re-recorded with it.
 */
export const JUDGE_QUESTIONS = {
  feasible: noul(
    'Can the rover realistically complete this segment as planned, arriving at the destination without being stopped short or failing?',
    {
      true: 'A route was found and it runs over mostly seen, firm ground with gentle or moderate slopes and at most a moderate detour.',
      false:
        'No route was found, or the route crosses mostly unseen ground, climbs slopes near the limit, runs over mostly loose ground or takes a long detour.',
    },
  ),
  distance_confidence: score(
    'How closely will the distance the rover actually drives match the planned path length?',
    [
      'No route was found, or the route crosses mostly unseen ground with a long detour, so replans will likely change the driven distance a lot.',
      'The route crosses mostly unseen ground, or partly unseen ground with a long detour; the driven distance will likely differ noticeably from the plan.',
      'The route crosses partly unseen ground or takes a moderate detour; some replanning may lengthen the drive.',
      'The route is mostly seen with at most a moderate detour; the driven distance should stay close to the plan.',
      'The route is fully seen, nearly straight and gentle; the rover will drive almost exactly the planned distance.',
    ],
  ),
  time_confidence: score(
    'How closely will the actual drive time match the estimated drive minutes? The estimate counts imaging stops and turns in place; slopes and loose ground slow the rover, and blocking ground found on unseen stretches adds assessments and replans.',
    [
      'No route was found, or the route crosses mostly unseen ground with a long detour and slopes near the limit, so the drive time is largely unknown.',
      'The route crosses mostly unseen ground or loose ground on steep slopes; replans and slowdowns will likely stretch the drive a lot.',
      'The route crosses partly unseen ground, some loose ground or moderate slopes with several turns in place; the drive will likely take noticeably longer.',
      'The route is mostly seen and firm with moderate slopes or a few turns in place; the drive should take close to the estimate.',
      'The route is fully seen, firm, gentle and nearly straight with few turns; the drive will take almost exactly the estimate.',
    ],
  ),
  risk: score('How likely is the rover to be stopped or to fail on this drive?', [
    'Seen, firm and gentle ground all the way; nothing is likely to stop the rover.',
    'Some unseen stretches or moderate slopes; a safe stop short of the destination is possible but unlikely.',
    'Much unseen ground, loose ground or slopes near the limit; being stopped short or getting stuck is a real possibility.',
    'No route was found, or the route combines unseen ground with slopes near the limit or mostly loose ground; stopping short or failing is likely.',
  ]),
} as const

export type JudgeQuestions = typeof JUDGE_QUESTIONS
