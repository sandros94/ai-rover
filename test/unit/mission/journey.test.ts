import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { journeyDrive, journeyPage, parseJourneyPage } from '#server/utils/mission/journey'
import { MissionError } from '#shared/utils/mission'
import { createTestDb, dbErrorOf, seedJourney } from '../db/helpers'

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
    expect(one.trail).toEqual([
      { index: 0, x: 0, y: 0 },
      { index: 1, x: 0, y: 80 },
    ])
    const first = await journeyDrive(db, { missionId: j.mission.id, segmentId: j.arrival.id })
    expect(first.trail).toEqual([{ index: 0, x: 0, y: 0 }])
  })

  it('refuses the drive still playing as not found, leaking nothing', async () => {
    const j = await seedJourney(db)
    const error = await dbErrorOf(
      journeyDrive(db, { missionId: j.mission.id, segmentId: j.driving.id }),
    )
    expect(error?.code).toBe('NOT_FOUND')
    // The id itself is random hex and may hold "85" by chance.
    expect(error?.message.replace(j.driving.id, '')).not.toMatch(/failed|stuck|85/)
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
