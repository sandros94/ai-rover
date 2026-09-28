import { describe, expect, it } from 'vitest'
import { Group } from 'three'
import { DIFFERENTIAL_RATIO } from '#shared/utils/client/scene'
import { DEFAULT_ROVER_LIMITS, poseOnTerrain } from '#shared/utils/rover'
import {
  coupledJoints,
  jointControls,
  SOLVED_JOINTS,
  solvedJoints,
} from '~~/modules/dev/runtime/app/playground/rover-joints'

function node(name: string, extras: Record<string, unknown>, ...children: Group[]): Group {
  const group = new Group()
  group.name = name
  group.userData = extras
  group.add(...children)
  return group
}

describe('jointControls', () => {
  it('lists every node carrying a joint, over its URDF limits or the solver travel', () => {
    const model = node(
      'chassis',
      {},
      node('mast_azimuth', { joint: 'RSM_AZ_ENC', limit: [0, 6.31809], baked: 3.159 }),
      node(
        'left_rocker',
        { joint: 'LEFT_DIFFERENTIAL' },
        node('left_differential_link', { aim: {} }),
        node('wheel_lf', { joint: 'LF_DRIVE' }),
      ),
    )
    const { differentialRad } = DEFAULT_ROVER_LIMITS
    expect(jointControls(model)).toEqual([
      { node: 'mast_azimuth', joint: 'RSM_AZ_ENC', min: 0, max: 6.31809, rest: 3.159 },
      {
        node: 'left_rocker',
        joint: 'LEFT_DIFFERENTIAL',
        min: -differentialRad,
        max: differentialRad,
        rest: 0,
      },
      { node: 'wheel_lf', joint: 'LF_DRIVE', min: -Math.PI, max: Math.PI, rest: 0 },
    ])
  })
})

describe('coupledJoints', () => {
  it('moves the rockers equal and opposite, the bar after the left one', () => {
    const left = { left_rocker: 0.1, right_rocker: -0.1, differential: -DIFFERENTIAL_RATIO * 0.1 }
    expect(coupledJoints('left_rocker', 0.1)).toEqual(left)
    expect(coupledJoints('right_rocker', -0.1)).toEqual(left)
    const fromBar = coupledJoints('differential', -DIFFERENTIAL_RATIO * 0.1)
    expect(fromBar.left_rocker).toBeCloseTo(0.1, 12)
  })

  it('sets any other joint alone', () => {
    expect(coupledJoints('steer_lf', 0.3)).toEqual({ steer_lf: 0.3 })
  })
})

describe('solvedJoints', () => {
  it('sets exactly the suspension joints, from the solved angles', () => {
    const pose = poseOnTerrain((x, y) => 0.1 * y + (x < -0.8 && y > 0.6 ? 0.2 : 0), {
      x: 0,
      y: 0,
      headingRad: 0,
    })
    const joints = solvedJoints(pose)
    expect(new Set(Object.keys(joints))).toEqual(SOLVED_JOINTS)
    expect(joints.left_bogie).toBe(pose.bogie.left)
    expect(joints.differential).toBeCloseTo(-DIFFERENTIAL_RATIO * pose.rocker.left, 12)
  })
})
