import { describe, expect, it } from 'vitest'
import type { RoverActivitySource } from '#shared/utils/client'
import { roverActivity } from '#shared/utils/client'

const OPEN_ROUND = { closesAt: null }
const PICKED_ROUND = { closesAt: '2026-09-26T09:05:00.000Z' }
const PAUSE = { message: 'Dust storm.' }

const state = (overrides: Partial<RoverActivitySource> = {}): RoverActivitySource => ({
  segment: null,
  round: OPEN_ROUND,
  pause: null,
  ...overrides,
})
const words = (source: RoverActivitySource, live: Parameters<typeof roverActivity>[1] = null) => {
  const { kind, label, short } = roverActivity(source, live)
  return { kind, label, short }
}

describe('roverActivity', () => {
  it('is idle at a stop with nobody picking, with or without a round', () => {
    expect(words(state())).toEqual({ kind: 'idle', label: 'Idle', short: 'Idle' })
    expect(words(state({ round: null }))).toEqual({ kind: 'idle', label: 'Idle', short: 'Idle' })
  })

  it('is in the planning phase once the round has a closing time', () => {
    expect(words(state({ round: PICKED_ROUND }))).toEqual({
      kind: 'planning',
      label: 'Planning phase',
      short: 'Planning',
    })
  })

  it("is paused under an operator's pause while no drive plays", () => {
    expect(words(state({ pause: PAUSE, round: PICKED_ROUND }))).toEqual({
      kind: 'paused',
      label: 'Mission paused',
      short: 'Paused',
    })
  })

  it("reads the drive's live status while one plays, the pause notwithstanding", () => {
    const driving = state({ segment: {}, pause: PAUSE })
    expect(roverActivity(driving, { status: 'steering' })).toEqual({
      kind: 'drive',
      status: 'steering',
      label: 'Steering wheels',
      short: 'Steering',
    })
    expect(words(driving, { status: 'turning' }).label).toBe('Turning')
    expect(words(driving, { status: 'imaging' }).label).toBe('Imaging')
    expect(words(driving, { status: 'assessing' }).label).toBe('Assessing')
  })

  it('reads as driving until the live status is known', () => {
    expect(roverActivity(state({ segment: {} }), null)).toMatchObject({
      kind: 'drive',
      status: 'driving',
      label: 'Driving',
    })
  })

  it('names the ending of a drive that stopped before it settled', () => {
    const driving = state({ segment: {} })
    expect(roverActivity(driving, { status: 'stopped', ending: 'blocked' })).toEqual({
      kind: 'drive',
      status: 'stopped',
      ending: 'blocked',
      label: 'Stopped short',
      short: 'Stopped',
    })
    expect(words(driving, { status: 'stopped', ending: 'stuck' }).label).toBe('Stuck')
    expect(words(driving, { status: 'stopped', ending: 'hazard' }).label).toBe('Hazard')
    expect(words(driving, { status: 'stopped', ending: 'arrived' }).label).toBe('Arrived')
    expect(words(driving, { status: 'stopped' }).label).toBe('Stopped')
  })

  it('ignores a live status once no drive plays: a settled drive played back is not the rover', () => {
    expect(words(state(), { status: 'driving' }).kind).toBe('idle')
  })
})
