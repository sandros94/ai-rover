import { beforeAll, describe, expect, it } from 'vitest'
import type { Document } from '@gltf-transform/core'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import {
  ARM_JOINTS,
  ARM_STOWED,
  DEFAULT_ROVER_GEOMETRY,
  DEFAULT_ROVER_LIMITS,
} from '#shared/utils/rover'
import {
  ARM_NIGHT,
  ARM_SEQUENCE_S,
  armPoseAlong,
  DIFFERENTIAL_RATIO,
} from '#shared/utils/client/scene'
import type { Box } from '~~/scripts/rover-model/clearance'
import {
  bodyPoint,
  BoxIndex,
  boundingVolumes,
  posedBoxes,
  poseModel,
} from '~~/scripts/rover-model/clearance'
import MODEL_FILES from '~~/app/utils/rover-model-files.json'

/** Tests run from the repository root. */
const MODEL = `public/${MODEL_FILES.full}`
/** The gap the night pose keeps from the rest of the rover, metres, on the bounding boxes. */
const CLEARANCE = 0.05
/** The gap every link keeps along the unstow once off its rest, metres. */
const PATH_CLEARANCE = 0.03
/** The upper arm is hinged at the chassis: its boxes this near the shoulder are not measured. */
const SHOULDER_M = 0.3
/** Sol seconds between poses checked along the unstow. */
const STEP_S = 0.1

let doc: Document
let volumes: ReturnType<typeof boundingVolumes>
/** The rest of the rover, over the suspension's travel, and without the shoulder's mount. */
let obstacles: { all: BoxIndex; beyondShoulder: BoxIndex }

const node = (name: string) =>
  doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name)!

beforeAll(async () => {
  await MeshoptDecoder.ready
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  doc = await io.read(MODEL)
  volumes = boundingVolumes(doc)
  const { differentialRad, bogieRad } = DEFAULT_ROVER_LIMITS
  const moving = [...volumes.keys()].filter(
    (n) => n !== 'chassis' && !n.startsWith('mast_') && !n.startsWith('arm_'),
  )
  // Rockers each way and every pair of bogie extremes: the wheels over their whole travel.
  const suspension: Box[] = []
  for (const rocker of [-differentialRad, 0, differentialRad]) {
    for (const left of [-bogieRad, bogieRad]) {
      for (const right of [-bogieRad, bogieRad]) {
        poseModel(doc, {
          left_rocker: rocker,
          right_rocker: -rocker,
          differential: -DIFFERENTIAL_RATIO * rocker,
          left_bogie: left,
          right_bogie: right,
        })
        for (const n of moving) suspension.push(...posedBoxes(doc, volumes, n))
      }
    }
  }
  poseModel(doc, {})
  const shoulder = bodyPoint(node('arm_2'), [0, 0, 0]).at
  const chassis = posedBoxes(doc, volumes, 'chassis')
  const beyond = chassis.filter(({ min, max }) => {
    const c = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2)
    return Math.hypot(c[0]! - shoulder[0], c[1]! - shoulder[1], c[2]! - shoulder[2]) >= SHOULDER_M
  })
  const mast = ['mast_azimuth', 'mast_elevation'].flatMap((n) => posedBoxes(doc, volumes, n))
  obstacles = {
    all: new BoxIndex([...chassis, ...mast, ...suspension]),
    beyondShoulder: new BoxIndex([...beyond, ...mast, ...suspension]),
  }
})

/** Each moving arm link's smallest gap to the rest of the rover at `pose`, up to `reach`. */
function linkGaps(pose: Record<string, number>, reach = 0.3): Record<string, number> {
  poseModel(doc, pose)
  return Object.fromEntries(
    ['arm_2', 'arm_3', 'arm_4', 'arm_5'].map((arm) => [
      arm,
      (arm === 'arm_2' ? obstacles.beyondShoulder : obstacles.all).gap(
        posedBoxes(doc, volumes, arm),
        reach,
      ),
    ]),
  )
}

/** The arm's smallest gap to the rest of the rover at `pose`, up to 0.3 m. */
function clearance(pose: Record<string, number>): number {
  return Math.min(...Object.values(linkGaps(pose)))
}

describe('the night arm pose', () => {
  it('keeps every joint within its URDF limits', () => {
    for (const { node: name, limit } of ARM_JOINTS) {
      expect(ARM_NIGHT[name]).toBeGreaterThanOrEqual(limit[0])
      expect(ARM_NIGHT[name]).toBeLessThanOrEqual(limit[1])
    }
  })

  it('measures the stowed arm resting on the rover, as the check must', () => {
    expect(clearance(ARM_STOWED)).toBe(0)
  })

  it(`clears the mast, the deck and the wheels at full suspension travel by ${CLEARANCE * 100} cm`, () => {
    expect(clearance(ARM_NIGHT)).toBeGreaterThanOrEqual(CLEARANCE)
  })

  it('raises the turret over the front deck, its lamp on the ground about 3 m ahead of the wheels', () => {
    poseModel(doc, ARM_NIGHT)
    const turret = node('turret')
    const beam = (turret.getExtras() as { beam: [number, number, number] }).beam
    const { at, direction } = bodyPoint(turret, [0, 0, 0], beam)
    expect(at[0]).toBeGreaterThan(1.4)
    expect(at[2]).toBeGreaterThan(1.6)
    expect(direction![2]).toBeLessThan(0)
    const s = -at[2] / direction![2]
    const ahead = at[0] + direction![0] * s - DEFAULT_ROVER_GEOMETRY.frontWheel.x
    expect(ahead - DEFAULT_ROVER_GEOMETRY.wheelRadius).toBeGreaterThan(2.5)
    expect(ahead - DEFAULT_ROVER_GEOMETRY.wheelRadius).toBeLessThan(3.5)
    expect(Math.abs(at[1] + direction![1] * s)).toBeLessThan(0.5)
  })
})

describe('the arm unstow', () => {
  it(`clears the mast, the deck and the wheels at full suspension travel by ${PATH_CLEARANCE * 100} cm once each link is off its rest`, () => {
    // Along the timed unstow every tenth of a second, at most 0.2° of any joint. A link resting
    // on the rover at the start may touch while it lifts off, its gap only growing, until it
    // first clears.
    const lifted = new Set<string>()
    const lifting: Record<string, number> = {}
    const faults: string[] = []
    let least = Infinity
    const steps = Math.ceil(ARM_SEQUENCE_S / STEP_S)
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(ARM_SEQUENCE_S, i * STEP_S)
      for (const [arm, g] of Object.entries(linkGaps(armPoseAlong(t), 0.1))) {
        const where = `${arm} at ${t.toFixed(1)} s: ${g.toFixed(3)} m`
        if (lifted.has(arm)) {
          if (g < PATH_CLEARANCE) faults.push(where)
          least = Math.min(least, g)
        } else {
          if (g < (lifting[arm] ?? 0)) faults.push(`${where}, closer while lifting off`)
          lifting[arm] = g
          if (g >= PATH_CLEARANCE) lifted.add(arm)
        }
      }
    }
    expect(faults).toEqual([])
    expect([...lifted].sort()).toEqual(['arm_2', 'arm_3', 'arm_4', 'arm_5'])
    expect(least).toBeGreaterThanOrEqual(PATH_CLEARANCE)
  }, 120_000)
})
