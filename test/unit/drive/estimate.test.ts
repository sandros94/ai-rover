import { describe, expect, it } from 'vitest'
import { estimatedDriveMinutes } from '#shared/utils/drive'

describe('estimatedDriveMinutes', () => {
  it('adds imaging stops and turns in place to the path at cruise speed', () => {
    const plan = {
      metrics: { reached: true, pathLengthM: 60 },
      motions: [
        { type: 'turn', angleRad: Math.PI / 2 },
        { type: 'arc', lengthM: 30, curvature: 0 },
        { type: 'turn', angleRad: -Math.PI / 2 },
        { type: 'arc', lengthM: 30, curvature: 0 },
      ] as const,
    }
    // 60 m at 0.033 m/s is 1818.2 s; two imaging stops of 30 s at 25 and 50 m; 180° at 3°/s is 60 s.
    // 1938.2 s is 32.3 min.
    expect(estimatedDriveMinutes(plan)).toBe(32)
  })

  it('is 0 for a route not reached', () => {
    expect(
      estimatedDriveMinutes({ metrics: { reached: false, pathLengthM: 0 }, motions: [] }),
    ).toBe(0)
  })
})
