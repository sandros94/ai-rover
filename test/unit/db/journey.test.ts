import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { getJourneySegment, listJourneySegments } from '#server/repositories/segments'
import { createTestDb, dbErrorOf, JOURNEY_T0, JUDGMENT, seedJourney } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const HOUR = 3_600_000
const plus = (ms: number) => new Date(JOURNEY_T0.getTime() + ms)
const journey = () => seedJourney(db)

describe('listJourneySegments', () => {
  it('lists settled drives newest first with stops, submitter and running distance', async () => {
    const j = await journey()
    const { segments, total } = await listJourneySegments(db, j.mission.id, {
      limit: 50,
      offset: 0,
    })
    expect(total).toBe(2)
    expect(segments.map((s) => s.id)).toEqual([j.failure.id, j.arrival.id])
    expect(segments[0]).toMatchObject({
      number: 2,
      attempt: 1,
      status: 'failed',
      startedAt: plus(2 * HOUR),
      endedAt: plus(3 * HOUR),
      distanceM: 42,
      durationS: 42 * 30,
      reasons: ['stuck'],
      from: { id: j.reached.id, index: 1, x: 0, y: 80 },
      to: null,
      goal: { x: 30, y: 100 },
      death: { x: 30, y: 100 },
      submitter: { id: j.user.id, displayName: 'Ada', avatarUrl: null },
      journeyBeforeM: 80,
      judgment: JUDGMENT,
    })
    expect(segments[1]).toMatchObject({
      number: 1,
      status: 'arrived',
      from: { index: 0 },
      to: { id: j.reached.id, index: 1 },
      death: null,
      journeyBeforeM: 0,
    })
    for (const s of segments) expect(s).not.toHaveProperty('outcome')
  })

  it('pages by offset, keeping numbers and running distance of the whole journey', async () => {
    const j = await journey()
    const page = await listJourneySegments(db, j.mission.id, { limit: 1, offset: 1 })
    expect(page.total).toBe(2)
    expect(page.segments.map((s) => [s.id, s.number])).toEqual([[j.arrival.id, 1]])
    expect((await listJourneySegments(db, j.mission.id, { limit: 1, offset: 5 })).segments).toEqual(
      [],
    )
  })
})

describe('getJourneySegment', () => {
  it('reads one settled drive of the mission as the list shows it', async () => {
    const j = await journey()
    const one = await getJourneySegment(db, j.failure.id, { missionId: j.mission.id })
    const [listed] = (await listJourneySegments(db, j.mission.id, { limit: 1, offset: 0 })).segments
    expect(one).toEqual(listed)
  })

  it('does not find the drive still playing, nor one of another mission', async () => {
    const j = await journey()
    const other = await journey()
    const playing = await dbErrorOf(
      getJourneySegment(db, j.driving.id, { missionId: j.mission.id }),
    )
    expect(playing?.code).toBe('NOT_FOUND')
    const foreign = await dbErrorOf(
      getJourneySegment(db, other.arrival.id, { missionId: j.mission.id }),
    )
    expect(foreign?.code).toBe('NOT_FOUND')
  })
})
