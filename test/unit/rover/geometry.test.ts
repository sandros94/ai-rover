import { describe, expect, it } from 'vitest'
import { DEFAULT_ROVER_GEOMETRY, defineRoverGeometry } from '#shared/utils/rover'
import { DEG, roverErrorOf } from './helpers'

describe('defineRoverGeometry', () => {
  it('fills the Perseverance-class defaults', () => {
    const g = defineRoverGeometry()
    expect(g.wheelRadius).toBe(0.263)
    expect(g.wheelWidth).toBe(0.335)
    expect(g.frontWheel).toEqual({ x: 1.185, y: 1.065 })
    expect(g.middleWheel).toEqual({ x: 0, y: 1.185 })
    expect(g.rearWheel).toEqual({ x: -1.075, y: 1.065 })
    expect(g.bellyClearance).toBe(0.6)
    expect(g).toEqual(DEFAULT_ROVER_GEOMETRY)
  })

  it('derives link lengths and flat link angles matching the model estimates', () => {
    const { links, rockerFlatRad, bogieFlatRad } = DEFAULT_ROVER_GEOMETRY
    // Model-derived: rocker 1.07 / 0.67 m, bogie 0.67 / 0.95 m; rocker-front 38°, bogie-middle 61°.
    expect(links.rockerFront).toBeCloseTo(1.07, 2)
    expect(links.rockerBogie).toBeCloseTo(0.67, 2)
    expect(links.bogieMiddle).toBeCloseTo(0.67, 2)
    expect(links.bogieRear).toBeCloseTo(0.95, 2)
    expect(links.middleToRear).toBeCloseTo(1.075, 12)
    expect(rockerFlatRad / DEG).toBeCloseTo(38, 0)
    expect(bogieFlatRad / DEG).toBeCloseTo(61, 0)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ROVER_GEOMETRY)).toBe(true)
    expect(Object.isFrozen(DEFAULT_ROVER_GEOMETRY.links)).toBe(true)
    expect(Object.isFrozen(DEFAULT_ROVER_GEOMETRY.frontWheel)).toBe(true)
  })

  it('accepts overrides', () => {
    const g = defineRoverGeometry({ wheelRadius: 0.25, bellyClearance: 0.5 })
    expect(g.wheelRadius).toBe(0.25)
    expect(g.bellyClearance).toBe(0.5)
  })

  it.each([
    ['a zero wheel radius', { wheelRadius: 0 }],
    ['a NaN wheel width', { wheelWidth: Number.NaN }],
    ['a negative belly length', { bellyLength: -1 }],
    ['an infinite belly offset', { bellyOffsetX: Infinity }],
    ['a non-positive lateral offset', { middleWheel: { x: 0, y: 0 } }],
    ['wheels out of order', { frontWheel: { x: -0.1, y: 1.065 } }],
    ['a bogie pivot outside its wheels', { bogiePivot: { x: 0.1, z: 0.85 } }],
    ['a rocker pivot behind the bogie pivot', { rockerPivot: { x: -0.5, z: 0.92 } }],
    ['a pivot below the axles', { bogiePivot: { x: -0.33, z: 0.2 } }],
  ])('refuses %s', (_, geometry) => {
    expect(roverErrorOf(() => defineRoverGeometry(geometry))?.code).toBe('INVALID_GEOMETRY')
  })
})
