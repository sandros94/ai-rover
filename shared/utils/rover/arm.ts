/**
 * Perseverance's robotic arm: five revolute joints from the shoulder's azimuth to the turret, as
 * JPL's URDF (`m2020-urdf-models`) names and limits them. The rover model carries each as a node
 * named here, turned about the URDF axis.
 */
export const ARM_JOINTS = [
  { node: 'arm_1', urdf: 'JOINT1_ENC', limit: [-3.145, 1.592] },
  { node: 'arm_2', urdf: 'JOINT2_ENC', limit: [-3.267, 0.126] },
  { node: 'arm_3', urdf: 'JOINT3_ENC', limit: [-2.866, 2.866] },
  { node: 'arm_4', urdf: 'JOINT4_ENC', limit: [-0.178, 3.669] },
  { node: 'arm_5', urdf: 'JOINT5_ENC', limit: [-0.353, 6.636] },
] as const satisfies readonly { node: string; urdf: string; limit: readonly [number, number] }[]

export type ArmNode = (typeof ARM_JOINTS)[number]['node']

/** Arm joint values, radians, by model node name. */
export type ArmPose = Record<ArmNode, number>

/**
 * The arm stowed for driving, as the rover reported it: the joint resolvers in the PDS label of
 * Navcam image `nlf_0100_0675828717_276edr_n0040218ncam00503_01_295j` (sol 100), the same to a
 * milliradian at sol 200.
 */
export const ARM_STOWED: ArmPose = {
  arm_1: 1.57232,
  arm_2: -0.286038,
  arm_3: -2.82087,
  arm_4: 3.10981,
  arm_5: 4.86082,
}
