import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import {
  journeyDrive,
  journeyPage,
  parseJourneyPage,
  parseJourneyRange,
} from '#server/utils/mission/journey'
import { MissionError } from '#shared/utils/mission'
import { settleSegment } from '#server/repositories/segments'
import { createTestDb, dbErrorOf, JOURNEY_T0, seedJourney } from '../db/helpers'

const HOUR = 3_600_000
const plus = (ms: number) => new Date(JOURNEY_T0.getTime() + ms)

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

describe('journeyPage', () => {
  it('lists settled drives only, newest first, with the public judgment and no outcome', async () => {
    const j = await seedJourney(db)
    const page = await journeyPage(db, { missionId: j.mission.id, page: 1 })
    expect(page).toMatchObject({ page: 1, pageSize: 50, total: 2 })
    expect(page.drives.map((d) => d.id)).toEqual([j.failure.id, j.arrival.id])
    expect(page.drives[0]!.judgment).toEqual({
      feasible: 0.9,
      verdict: 'accept',
      risk: 1,
      distanceWeight: 1,
      timeWeight: 2 / 3,
      probabilities: {
        risk: [0.2, 0.7, 0.1, 0],
        distanceConfidence: [0, 0.1, 0.2, 0.7],
        timeConfidence: [0.1, 0.2, 0.6, 0.1],
      },
    })
    const wire = JSON.stringify(page)
    // The drive still playing: neither its id nor where it ends.
    expect(wire).not.toContain(j.driving.id)
    expect(wire).not.toContain('"outcome"')
    expect(wire).not.toContain('endPose')
  })

  it('answers an empty page past the end', async () => {
    const j = await seedJourney(db)
    const page = await journeyPage(db, { missionId: j.mission.id, page: 2 })
    expect(page).toMatchObject({ page: 2, total: 2, drives: [] })
  })
})

describe('journeyPage over a range', () => {
  it('lists the settled drives numbered from and to, oldest first, as a playlist plays them', async () => {
    const j = await seedJourney(db)
    const both = await journeyPage(db, {
      missionId: j.mission.id,
      page: 1,
      range: { from: 1, to: 2 },
    })
    expect(both).toMatchObject({ page: 1, pageSize: 50, total: 2 })
    expect(both.drives.map((d) => [d.id, d.number])).toEqual([
      [j.arrival.id, 1],
      [j.failure.id, 2],
    ])
    const second = await journeyPage(db, { missionId: j.mission.id, page: 1, range: { from: 2 } })
    expect(second).toMatchObject({ total: 1 })
    expect(second.drives.map((d) => d.id)).toEqual([j.failure.id])
    const first = await journeyPage(db, { missionId: j.mission.id, page: 1, range: { to: 1 } })
    expect(first.drives.map((d) => d.id)).toEqual([j.arrival.id])
    const none = await journeyPage(db, { missionId: j.mission.id, page: 1, range: { from: 3 } })
    expect(none).toMatchObject({ total: 0, drives: [] })
  })

  it('lists the drives that ended after `since`, never the one still playing', async () => {
    const j = await seedJourney(db)
    const page = (since: Date) =>
      journeyPage(db, { missionId: j.mission.id, page: 1, range: { since } })
    const all = await page(plus(-HOUR))
    expect(all.drives.map((d) => d.id)).toEqual([j.arrival.id, j.failure.id])
    // Strictly after: a drive ending at `since` is the one already seen.
    const after = await page(plus(HOUR))
    expect(after.drives.map((d) => d.id)).toEqual([j.failure.id])
    expect(after.total).toBe(1)
    const later = await page(plus(3 * HOUR))
    expect(later).toMatchObject({ total: 0, drives: [] })
    expect(JSON.stringify(all)).not.toContain(j.driving.id)
  })

  it('combines `since` with numbers', async () => {
    const j = await seedJourney(db)
    const page = await journeyPage(db, {
      missionId: j.mission.id,
      page: 1,
      range: { since: plus(-HOUR), from: 2, to: 2 },
    })
    expect(page.drives.map((d) => d.id)).toEqual([j.failure.id])
  })
})

describe('parseJourneyRange', () => {
  it('reads segment numbers and an ISO instant, nothing when none is given', () => {
    expect(parseJourneyRange({})).toBeUndefined()
    expect(parseJourneyRange({ page: '2' })).toBeUndefined()
    expect(parseJourneyRange({ from: '3', to: '7' })).toEqual({ from: 3, to: 7 })
    expect(parseJourneyRange({ from: '3' })).toEqual({ from: 3 })
    expect(parseJourneyRange({ since: '2026-09-25T12:00:00.000Z' })).toEqual({
      since: new Date('2026-09-25T12:00:00.000Z'),
    })
  })

  it('refuses bad numbers, a reversed range and a bad instant with a typed error', () => {
    for (const query of [
      { from: '0' },
      { to: '-1' },
      { from: '1.5' },
      { from: ['1', '2'] },
      { from: '5', to: '4' },
      { since: 'yesterday' },
      { since: '' },
    ]) {
      expect(() => parseJourneyRange(query)).toThrow(MissionError)
    }
  })
})

describe('journeyDrive', () => {
  it('gives one settled drive with the mission clock, rules and the stops up to its start', async () => {
    const j = await seedJourney(db)
    const one = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.failure.id })
    expect(one.drive).toMatchObject({
      id: j.failure.id,
      status: 'failed',
      death: { x: 30, y: 100 },
    })
    expect(one.mission).toMatchObject({ id: j.mission.id, solsEpoch: j.mission.solsEpoch })
    expect(one.mission.rules).toEqual(j.mission.config.rules)
    // The public facts of the live map: which drive reached each stop, and when.
    expect(one.trail).toEqual([
      { index: 0, x: 0, y: 0, reachedBy: null },
      {
        index: 1,
        x: 0,
        y: 80,
        reachedBy: { segmentId: j.arrival.id, number: 1, fromIndex: 0, at: j.arrival.endsAt },
      },
    ])
    // A drive's own death is its replay's to show; none came before it.
    expect(one.deaths).toEqual([])
    const first = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.arrival.id })
    expect(first.trail).toEqual([{ index: 0, x: 0, y: 0, reachedBy: null }])
  })

  it('gives the deaths public when the drive started, with the facts the live map shows', async () => {
    const j = await seedJourney(db)
    await settleSegment(db, j.driving.id, {
      now: j.driving.endsAt,
      status: 'failed',
      death: { x: 5, y: 85 },
    })
    const third = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.driving.id })
    expect(third.deaths).toEqual([
      {
        x: 30,
        y: 100,
        segmentId: j.failure.id,
        number: 2,
        fromIndex: 1,
        reasons: j.failure.outcome!.reasons,
        at: j.failure.endsAt,
        distanceM: j.failure.outcome!.distanceM,
      },
    ])
  })

  it('names the settled drive after it, if any, to continue with', async () => {
    const j = await seedJourney(db)
    const first = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.arrival.id })
    expect(first.next).toEqual({ id: j.failure.id, number: 2 })
    // The drive after the latest settled one is still playing: nothing to continue with.
    const last = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.failure.id })
    expect(last.next).toBeNull()
  })

  it('refuses the drive still playing as not found, leaking nothing', async () => {
    const j = await seedJourney(db)
    const error = await dbErrorOf(
      journeyDrive(db, { missionId: j.mission.id, segmentId: j.driving.id }),
    )
    expect(error?.code).toBe('NOT_FOUND')
    // The ids are random hex and may hold "85" by chance.
    const text = error?.message.replace(j.driving.id, '').replace(j.mission.id, '')
    expect(text).not.toMatch(/failed|stuck|85/)
  })
})

describe('parseJourneyPage', () => {
  it('reads a positive page number, 1 when absent', () => {
    expect(parseJourneyPage(undefined)).toBe(1)
    expect(parseJourneyPage('3')).toBe(3)
  })

  it('refuses anything else with a typed error', () => {
    for (const raw of ['0', '-1', '1.5', 'x', ['1', '2']]) {
      expect(() => parseJourneyPage(raw)).toThrow(MissionError)
    }
  })
})
