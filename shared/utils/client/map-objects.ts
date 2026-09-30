import { formatLmst, solTime } from './instruments/sol-clock'
import { routeDestination } from './scene/markers'

/**
 * Everything on the map a visitor can inspect: past stops, deaths, the open round's submissions
 * at their goals, the drive's destination and the rover. Each has an `id` unique across kinds
 * (`stop:3`, `death:<segment>`, `submission:<submission>`, `destination:<segment>`, `rover`),
 * which is what focus holds.
 */
export type MapObject =
  | StopObject
  | DeathObject
  | SubmissionObject
  | DestinationObject
  | RoverObject

export type MapObjectKind = MapObject['kind']

/** A moment as the map shows it: the instant, and the mission's sol and local mean solar time. */
export interface MarsMoment {
  iso: string
  sol: number
  /** `HH:MM:SS`. */
  lmst: string
}

/** A settled segment as an object names it. */
export interface SegmentRef {
  segmentId: string
  /** Among the mission's settled drives, from 1. */
  number: number
}

export interface StopObject {
  kind: 'stop'
  id: `stop:${number}`
  x: number
  y: number
  index: number
  /** Names the stop's stored objects: its manifest, and through it its mask and disk pack. */
  manifestKey: string
  /** The stop the rover stands at or left from. */
  current: boolean
  /** The segment that reached it and when; null for the landing stop. */
  reached: (SegmentRef & { at: MarsMoment }) | null
  /** Segments that left it, oldest first, with the stop each reached; null for a failure. */
  departures: (SegmentRef & { toIndex: number | null })[]
}

export interface DeathObject extends SegmentRef {
  kind: 'death'
  id: `death:${string}`
  x: number
  y: number
  /** Index of the stop the drive left. */
  fromIndex: number
  reasons: string[]
  /** When the drive's ending became public. */
  at: MarsMoment
  distanceM: number
}

export interface SubmissionObject {
  kind: 'submission'
  id: `submission:${string}`
  submissionId: string
  /** The goal. */
  x: number
  y: number
  author: { displayName: string; avatarUrl: string | null }
  /** From the round's anchor to the goal, straight. */
  distanceM: number
  bearing: { degrees: number; compass: Compass }
  verdict: string
  risk: number
  likes: number
}

/**
 * Where the drive in progress is headed, as it was planned: its flag at the route's end. Nothing
 * of how the drive goes: the arrival is the plan's, and the drive may stop short or fail.
 */
export interface DestinationObject {
  kind: 'destination'
  id: `destination:${string}`
  segmentId: string
  x: number
  y: number
  /** Index of the stop the drive left. */
  fromIndex: number
  /** The winning submission's author. */
  author: { displayName: string; avatarUrl: string | null }
  /** From the stop the drive left, straight. */
  distanceM: number
  bearing: { degrees: number; compass: Compass }
  /** The winning submission's route; null when it has none. */
  plan: { pathLengthM: number; estimatedMinutes: number } | null
  startedAt: string
  /** The start plus the estimated drive time; null without a plan. */
  plannedArrival: string | null
}

/** What the rover is doing, as its card says it. */
export type RoverStatus = 'driving' | 'planning' | 'waiting'

export interface RoverObject {
  kind: 'rover'
  id: 'rover'
  x: number
  y: number
  headingRad: number
  status: RoverStatus
  /** Ground speed, metres per second; null without a drive to read it from. */
  speedMps: number | null
  /** Share of the planned path driven, 0 to 1; null without a drive. */
  progress: number | null
}

/** The rover's object id: what the recentre control focuses. */
export const ROVER_ID = 'rover'

type Instant = string | Date

/** What the objects are built from: the public mission state, with dates as strings or not. */
export interface MapObjectsSource {
  mission: { solsEpoch: Instant }
  currentStop: { index: number }
  trail: readonly {
    index: number
    x: number
    y: number
    manifestKey: string
    reachedBy: { segmentId: string; number: number; fromIndex: number; at: Instant } | null
  }[]
  deaths: readonly {
    x: number
    y: number
    segmentId: string
    number: number
    fromIndex: number
    reasons: readonly string[]
    at: Instant
    distanceM: number
  }[]
  /**
   * A drive that left the current stop and has not reached anything shown yet, listed among the
   * stop's departures when where it ended is already public (a replay's playing drive).
   */
  departing?: { segmentId: string; number: number; fromIndex: number; toIndex: number | null }
  round: {
    anchor: { x: number; y: number }
    submissions: readonly {
      id: string
      goal: { x: number; y: number }
      likes: number
      submitter: { displayName: string; avatarUrl: string | null }
      judgment: { verdict: string; risk: number }
    }[]
  } | null
}

const iso = (at: Instant): string => (typeof at === 'string' ? at : at.toISOString())

function moment(epochMs: number, at: Instant): MarsMoment {
  const text = iso(at)
  const sol = solTime(epochMs, Date.parse(text))
  return { iso: text, sol: sol.sol, lmst: formatLmst(sol) }
}

/** The stops, deaths and submissions of `source`, in that order; the rover is added apart. */
export function mapObjects(source: MapObjectsSource): MapObject[] {
  const epochMs = Date.parse(iso(source.mission.solsEpoch))
  const departures = new Map<number, StopObject['departures']>()
  const depart = (fromIndex: number, entry: StopObject['departures'][number]) => {
    const list = departures.get(fromIndex) ?? []
    list.push(entry)
    departures.set(fromIndex, list)
  }
  for (const stop of source.trail) {
    const by = stop.reachedBy
    if (by)
      depart(by.fromIndex, { segmentId: by.segmentId, number: by.number, toIndex: stop.index })
  }
  for (const death of source.deaths) {
    depart(death.fromIndex, { segmentId: death.segmentId, number: death.number, toIndex: null })
  }
  const leaving = source.departing
  if (leaving && !source.deaths.some((death) => death.segmentId === leaving.segmentId)) {
    const { segmentId, number, toIndex } = leaving
    depart(leaving.fromIndex, { segmentId, number, toIndex })
  }

  const stops = source.trail.map((stop): StopObject => {
    const by = stop.reachedBy
    return {
      kind: 'stop',
      id: `stop:${stop.index}`,
      x: stop.x,
      y: stop.y,
      index: stop.index,
      manifestKey: stop.manifestKey,
      current: stop.index === source.currentStop.index,
      reached: by
        ? { segmentId: by.segmentId, number: by.number, at: moment(epochMs, by.at) }
        : null,
      departures: (departures.get(stop.index) ?? []).sort((a, b) => a.number - b.number),
    }
  })
  const deaths = source.deaths.map((death): DeathObject => ({
    kind: 'death',
    id: `death:${death.segmentId}`,
    x: death.x,
    y: death.y,
    segmentId: death.segmentId,
    number: death.number,
    fromIndex: death.fromIndex,
    reasons: [...death.reasons],
    at: moment(epochMs, death.at),
    distanceM: death.distanceM,
  }))
  const round = source.round
  const submissions = (round?.submissions ?? []).map((s): SubmissionObject => {
    const { distanceM, degrees, compass } = goalBearing(round!.anchor, s.goal)
    return {
      kind: 'submission',
      id: `submission:${s.id}`,
      submissionId: s.id,
      x: s.goal.x,
      y: s.goal.y,
      author: { displayName: s.submitter.displayName, avatarUrl: s.submitter.avatarUrl },
      distanceM,
      bearing: { degrees, compass },
      verdict: s.judgment.verdict,
      risk: s.judgment.risk,
      likes: s.likes,
    }
  })
  return [...stops, ...deaths, ...submissions]
}

/** A settled drive as a replay plays it: enough to name the stop it reached or its death. */
export interface PlayedDrive {
  id: string
  number: number
  endedAt: Instant
  distanceM: number
  reasons: readonly string[]
  from: { index: number }
  to: { index: number; x: number; y: number; manifestKey: string } | null
  death: { x: number; y: number } | null
}

/**
 * The stops and deaths a replay shows while `drives[playing]` plays: those public when the first
 * drive started (`before`), then the stop each earlier drive reached, and the death of every
 * drive up to the one playing, all with the facts the live map gives them.
 */
export function replayedStopsAndDeaths(
  before: Pick<MapObjectsSource, 'trail' | 'deaths'>,
  drives: readonly PlayedDrive[],
  playing: number,
): { trail: MapObjectsSource['trail'][number][]; deaths: MapObjectsSource['deaths'][number][] } {
  const stops = new Map(before.trail.map((stop) => [stop.index, stop]))
  const deaths = [...before.deaths]
  for (const [k, drive] of drives.slice(0, playing + 1).entries()) {
    const ref = { segmentId: drive.id, number: drive.number, fromIndex: drive.from.index }
    if (drive.to && k < playing) {
      const { index, x, y, manifestKey } = drive.to
      stops.set(index, { index, x, y, manifestKey, reachedBy: { ...ref, at: drive.endedAt } })
    }
    if (drive.death) {
      deaths.push({
        ...drive.death,
        ...ref,
        reasons: drive.reasons,
        at: drive.endedAt,
        distanceM: drive.distanceM,
      })
    }
  }
  return { trail: [...stops.values()].sort((a, b) => a.index - b.index), deaths }
}

/** The rover at `pose`, as its card and focus read it. */
export function roverObject(
  pose: { x: number; y: number; headingRad: number },
  info: { status: RoverStatus; speedMps: number | null; progress: number | null },
): RoverObject {
  return { kind: 'rover', id: ROVER_ID, ...pose, ...info }
}

/** What the destination is built from: the public mission state, with dates as strings or not. */
export interface DestinationSource {
  /** The stop the drive left: the rover's current stop until the drive settles. */
  currentStop: { index: number; x: number; y: number }
  trail: readonly { x: number; y: number }[]
  segment: {
    id: string
    startedAt: Instant
    submitter: { displayName: string; avatarUrl: string | null }
    plan: { pathLengthM: number; estimatedMinutes: number } | null
  } | null
}

/**
 * The destination of `source`'s drive, standing where its flag does: at the end of `route`, the
 * route the drive follows now. None without a drive or a route, or once a stop stands there.
 */
export function destinationObject(
  source: DestinationSource,
  route: readonly { x: number; y: number }[],
): DestinationObject | null {
  const segment = source.segment
  const end = segment && routeDestination(route, source.trail)
  if (!segment || !end) return null
  const from = source.currentStop
  const { distanceM, degrees, compass } = goalBearing(from, end)
  const startedAt = iso(segment.startedAt)
  const plan = segment.plan && { ...segment.plan }
  return {
    kind: 'destination',
    id: `destination:${segment.id}`,
    segmentId: segment.id,
    x: end.x,
    y: end.y,
    fromIndex: from.index,
    author: { ...segment.submitter },
    distanceM,
    bearing: { degrees, compass },
    plan,
    startedAt,
    plannedArrival: plan
      ? new Date(Date.parse(startedAt) + plan.estimatedMinutes * 60_000).toISOString()
      : null,
  }
}

/**
 * The destination's card lines: where it lies from the stop the drive left, the planned route,
 * and the planned arrival as a local time (in `options.timeZone`, by default the browser's).
 */
export function destinationLines(
  destination: DestinationObject,
  options: { locale?: string; timeZone?: string } = {},
): { heading: string; route: string | null; arrival: string | null } {
  const { distanceM, bearing, fromIndex, plan, plannedArrival } = destination
  const time = (at: string) =>
    new Date(at).toLocaleTimeString(options.locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: options.timeZone,
    })
  return {
    heading: `${Math.round(distanceM)} m · ${bearing.degrees}° ${bearing.compass} from stop ${fromIndex}`,
    route: plan ? `${plan.pathLengthM} m path · ${plan.estimatedMinutes} min` : null,
    arrival: plannedArrival ? `Arrival ${time(plannedArrival)}, planned` : null,
  }
}

/**
 * What the rover is doing by the public state: driving while a segment plays, in the planning
 * phase once the round has a closing time (the first pick is in), else waiting for one.
 */
export function roverStatus(state: {
  segment: unknown
  round: { closesAt: Instant | null } | null
}): RoverStatus {
  if (state.segment) return 'driving'
  return state.round?.closesAt ? 'planning' : 'waiting'
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
export type Compass = (typeof COMPASS)[number]

/** Distance and bearing of `goal` from `from`: whole degrees clockwise from north (world +y). */
export function goalBearing(
  from: { x: number; y: number },
  goal: { x: number; y: number },
): { distanceM: number; degrees: number; compass: Compass } {
  const dx = goal.x - from.x
  const dy = goal.y - from.y
  const degrees = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
  return {
    distanceM: Math.hypot(dx, dy),
    degrees: Math.round(degrees) % 360,
    compass: COMPASS[Math.round(degrees / 45) % 8]!,
  }
}

/** Pointer tolerance of the 2D map's hit-testing, screen pixels. */
export const HIT_TOLERANCE_PX = 12

/** Which object wins where several are within reach, first first. */
const PRIORITY: readonly MapObjectKind[] = ['rover', 'destination', 'submission', 'death', 'stop']

/**
 * The object at world point `at` within `toleranceM`: of those in reach, the first kind in
 * rover, destination, submission, death, stop order, then the nearest.
 */
export function hitMapObject<T extends { kind: MapObjectKind; x: number; y: number }>(
  objects: readonly T[],
  at: { x: number; y: number },
  options: { toleranceM: number },
): T | undefined {
  let best: { object: T; rank: number; distance: number } | undefined
  for (const object of objects) {
    const distance = Math.hypot(object.x - at.x, object.y - at.y)
    if (distance > options.toleranceM) continue
    const rank = PRIORITY.indexOf(object.kind)
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) {
      best = { object, rank, distance }
    }
  }
  return best?.object
}

/** Whether `a` and `b` are the same object; nothing is the same as nothing. */
export function sameMapObject(a: { id: string } | null, b: { id: string } | null): boolean {
  return a !== null && b !== null && a.id === b.id
}

/** How long the view takes to move onto a newly focused object, milliseconds. */
export const FOCUS_EASE_MS = 500

/**
 * The point between `from` and `to` after `elapsedMs` of a {@link FOCUS_EASE_MS} move, eased in
 * and out (cubic); `to` itself once the time is up.
 */
export function easeFocus<P extends { x: number; y: number; z?: number }>(
  from: P,
  to: P,
  elapsedMs: number,
): P {
  const p = Math.min(1, Math.max(0, elapsedMs / FOCUS_EASE_MS))
  if (p >= 1) return to
  const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
  const mix = (a: number, b: number) => a + (b - a) * e
  const out = { ...to, x: mix(from.x, to.x), y: mix(from.y, to.y) }
  if (from.z !== undefined && to.z !== undefined) out.z = mix(from.z, to.z)
  return out
}
