import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { Material, Mesh, MeshBasicMaterial, Object3D } from 'three'
import { PerspectiveCamera, Quaternion, Vector3 } from 'three'
import {
  ARM_NIGHT,
  armPoseAt,
  flatFrame,
  framePlacement,
  rigTransforms,
  ROVER_RIG_NODES,
  sunCrossings,
} from '#shared/utils/client/scene'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import { roverLookMaterial } from '#shared/utils/client/scene/rover-looks'
import type { LoadedRoverModel, RoverModelFile } from '~/utils/rover-model'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DeathGhosts from '~/components/scene/DeathGhosts.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverModel from '~/components/scene/RoverModel.vue'
import { motionAt } from '~~/modules/dev/runtime/app/playground/rover-motion'

/**
 * There is no canvas: the camera is the test's, frames are asked for through a spy, and the
 * render loop runs when the test says.
 */
const tres = vi.hoisted(() => ({
  camera: undefined as PerspectiveCamera | undefined,
  beforeRender: [] as (() => void)[],
  invalidate: vi.fn<() => void>(),
}))
vi.mock('@tresjs/core', async () => {
  const vue = await import('vue')
  return {
    useTres: () => ({ camera: vue.computed(() => tres.camera), invalidate: tres.invalidate }),
    useLoop: () => ({
      onBeforeRender: (callback: () => void) => {
        tres.beforeRender.push(callback)
      },
    }),
  }
})

/** Each test decides when, and whether, each model arrives. */
const loads = vi.hoisted(() => ({
  next: undefined as undefined | ((file: RoverModelFile) => Promise<LoadedRoverModel>),
}))
vi.mock('~/utils/rover-model', async (original) => ({
  ...(await original<typeof import('~/utils/rover-model')>()),
  loadRoverModel: (_baseURL: string, file: RoverModelFile) => loads.next!(file),
}))

/** Both models as the page's loader parses them, from the public folder. */
const models = {} as Record<RoverModelFile, LoadedRoverModel>
beforeAll(async () => {
  const actual = await vi.importActual<typeof import('~/utils/rover-model')>('~/utils/rover-model')
  const files: Record<RoverModelFile, string> = {
    'full': 'public/models/rover/rover.glb',
    'low-poly': 'public/models/rover/rover-ghost.glb',
  }
  for (const [file, path] of Object.entries(files) as [RoverModelFile, string][]) {
    const bytes = readFileSync(join(process.cwd(), path))
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes)))
    models[file] = await actual.loadRoverModel('/', file)
  }
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  tres.camera = undefined
  tres.beforeRender.length = 0
  tres.invalidate.mockClear()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)))
  return { promise, resolve, reject }
}

/** The copies each model's scene hands out, in order. */
function copiesOf(file: RoverModelFile): () => Object3D[] {
  const spy = vi.spyOn(models[file].scene, 'clone')
  return () => spy.mock.results.map((result) => result.value as Object3D)
}

const meshes = (object: Object3D) => {
  const out: Mesh[] = []
  object.traverse((node) => {
    if ((node as Mesh).isMesh) out.push(node as Mesh)
  })
  return out
}
/** The models under the rover's root, the lamp and its target left out. */
const modelsUnder = (root: Object3D) =>
  root.children.filter((child) => child.getObjectByName('chassis'))

/** Whether `copy`, a low-poly copy, is drawn into shadow maps alone. */
const castsOnly = (copy: Object3D) =>
  meshes(copy).every(
    (mesh) =>
      !(mesh.material as MeshBasicMaterial).colorWrite && mesh.castShadow && !mesh.receiveShadow,
  )
/** Whether `copy`, a low-poly copy, is drawn in the stand-in look. */
const standsIn = (copy: Object3D) =>
  copy.visible &&
  meshes(copy).every((mesh) => mesh.material === roverLookMaterial('standin') && mesh.castShadow)

/** A point turn's steering phase, its corner wheels part way round, with the arm in its night pose. */
const motion = motionAt('point-turn', 5)
const joints = { ...motion.joints, ...ARM_NIGHT }
const turn = new Quaternion()

/**
 * `copy`'s node `name` at `expected`, component by component: the model's rest rotations are
 * float32 and a hair off unit length, which an angle between them would read as a turn.
 */
function expectSame(name: string, copy: Object3D, expected: Quaternion): void {
  const q = copy.getObjectByName(name)!.quaternion
  expect([name, ...q.toArray()]).toEqual([
    name,
    ...expected.toArray().map((v) => expect.closeTo(v, 9)),
  ])
}

/**
 * Each joint of `copy` turned as the frame and `joints` say, from the model's own rests: a rig
 * node `joints` names takes its value from `joints`, which the model applies over the frame's.
 */
function expectPosed(file: RoverModelFile, copy: Object3D): void {
  const rest = models[file].scene
  const rig = rigTransforms(motion.frame).joints
  for (const name of ROVER_RIG_NODES) {
    if (name in joints) continue
    const q = rig[name]
    const expected = rest
      .getObjectByName(name)!
      .quaternion.clone()
      .multiply(turn.set(q.x, q.y, q.z, q.w))
    expectSame(name, copy, expected)
  }
  for (const [name, value] of Object.entries(joints)) {
    const node = rest.getObjectByName(name)!
    const { axis, baked } = node.userData as { axis: [number, number, number]; baked?: number }
    const expected = node.quaternion
      .clone()
      .multiply(turn.setFromAxisAngle(new Vector3(...axis).normalize(), value - (baked ?? 0)))
    expectSame(name, copy, expected)
  }
}

async function mountRover(
  full: Promise<LoadedRoverModel>,
  lowPoly: Promise<LoadedRoverModel>,
  props: { frame?: Float32Array; joints?: Record<string, number>; lodDistanceM?: number } = {},
) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  loads.next = (file) => (file === 'full' ? full : lowPoly)
  const rover = await mountSuspended(RoverModel, {
    props: { frame: motion.frame, joints, ...props },
  })
  await flushPromises()
  return rover
}

describe('the rover while its full model loads', () => {
  it('draws the stand-in first, posed by the frame, the steering and the arm night pose', async () => {
    expect(Math.abs(motion.frame[KEYFRAME_FIELDS.indexOf('steerFL')]!)).toBeGreaterThan(0.1)
    const standins = copiesOf('low-poly')
    const rover = await mountRover(
      deferred<LoadedRoverModel>().promise,
      Promise.resolve(models['low-poly']),
    )

    expect(standins()).toHaveLength(1)
    const standin = standins()[0]!
    expect(standin.parent).not.toBeNull()
    expect(standin.visible).toBe(true)
    for (const mesh of meshes(standin)) {
      expect(mesh.material).toBe(roverLookMaterial('standin'))
      expect([mesh.castShadow, mesh.receiveShadow]).toEqual([true, true])
    }
    expectPosed('low-poly', standin)
    expect(rover.emitted('status')).toEqual([['standin']])
  })

  it('crossfades to the full model once decoded, the low-poly model staying as its shadow caster', async () => {
    const full = deferred<LoadedRoverModel>()
    const standins = copiesOf('low-poly')
    const fulls = copiesOf('full')
    const rover = await mountRover(full.promise, Promise.resolve(models['low-poly']))
    const standin = standins()[0]!
    const root = standin.parent!

    full.resolve(models.full)
    await flushPromises()
    await vi.waitFor(() => expect(castsOnly(standin)).toBe(true), { timeout: 2000 })
    const model = fulls()[0]!
    expect(modelsUnder(root)).toEqual([standin, model])
    expect([model.visible, standin.visible]).toEqual([true, true])
    // Back on the model's own materials once the fade is over, casting no shadow of its own.
    const own = new Set(meshes(models.full.scene).map((mesh) => mesh.material as Material))
    for (const mesh of meshes(model)) {
      expect(own.has(mesh.material as Material)).toBe(true)
      expect([mesh.castShadow, mesh.receiveShadow]).toEqual([false, true])
    }
    expectPosed('full', model)
    expectPosed('low-poly', standin)
    expect(rover.emitted('status')).toEqual([['standin'], ['full']])
  })

  it('keeps the stand-in when the full model fails', async () => {
    const standins = copiesOf('low-poly')
    const rover = await mountRover(
      Promise.reject(new Error('no full model')),
      Promise.resolve(models['low-poly']),
    )
    await flushPromises()
    const standin = standins()[0]!
    expect(modelsUnder(standin.parent!)).toEqual([standin])
    expect(standin.visible).toBe(true)
    expect(rover.emitted('status')).toEqual([['standin']])
  })

  it('draws nothing and says so when the low-poly model fails', async () => {
    const standins = copiesOf('low-poly')
    const fulls = copiesOf('full')
    const rover = await mountRover(
      deferred<LoadedRoverModel>().promise,
      Promise.reject(new Error('no low-poly model')),
    )
    expect([...standins(), ...fulls()]).toEqual([])
    expect(rover.emitted('status')).toEqual([['unavailable']])
  })
})

describe('the rover at a distance', () => {
  it('draws the stand-in past lodDistanceM and the full model within, back only 10 % nearer', async () => {
    const camera = new PerspectiveCamera()
    tres.camera = camera
    const standins = copiesOf('low-poly')
    const fulls = copiesOf('full')
    await mountRover(Promise.resolve(models.full), Promise.resolve(models['low-poly']), {
      lodDistanceM: 40,
    })
    await vi.waitFor(() => expect(castsOnly(standins()[0]!)).toBe(true), { timeout: 2000 })
    const [standin, model] = [standins()[0]!, fulls()[0]!]
    const { position } = framePlacement(motion.frame)
    /** The camera `metres` from the rover, one frame drawn: whether it drew the full model. */
    const fullAt = (metres: number) => {
      camera.position.set(position.x + metres, position.y, position.z)
      tres.invalidate.mockClear()
      for (const callback of tres.beforeRender) callback()
      const detailed = model.visible
      expect(detailed ? castsOnly(standin) : standsIn(standin)).toBe(true)
      return { detailed, redrawn: tres.invalidate.mock.calls.length > 0 }
    }
    expect(fullAt(30)).toEqual({ detailed: true, redrawn: false })
    expect(fullAt(41)).toEqual({ detailed: false, redrawn: true })
    expect(fullAt(37)).toEqual({ detailed: false, redrawn: false })
    expect(fullAt(35)).toEqual({ detailed: true, redrawn: true })
    expect(fullAt(39.5)).toEqual({ detailed: true, redrawn: false })
    // The stand-in drawn far is the same copy in the same look as while the full model loads.
    fullAt(80)
    expect(meshes(standin).every((mesh) => mesh.material === roverLookMaterial('standin'))).toBe(
      true,
    )
    expectPosed('low-poly', standin)
  })

  it('draws the full model at any distance when the low-poly model fails, casting its own shadow', async () => {
    const camera = new PerspectiveCamera()
    tres.camera = camera
    const fulls = copiesOf('full')
    await mountRover(Promise.resolve(models.full), Promise.reject(new Error('no low-poly model')), {
      lodDistanceM: 40,
    })
    await flushPromises()
    const model = fulls()[0]!
    camera.position.set(1000, 0, 0)
    for (const callback of tres.beforeRender) callback()
    expect(model.visible).toBe(true)
    expect(meshes(model).every((mesh) => mesh.castShadow)).toBe(true)
  })
})

describe('the rover drawn on demand', () => {
  it('asks for a frame at every step of the crossfade', async () => {
    const full = deferred<LoadedRoverModel>()
    const standins = copiesOf('low-poly')
    await mountRover(full.promise, Promise.resolve(models['low-poly']))
    const steps = vi.spyOn(window, 'requestAnimationFrame')
    tres.invalidate.mockClear()
    full.resolve(models.full)
    await flushPromises()
    await vi.waitFor(() => expect(castsOnly(standins()[0]!)).toBe(true), { timeout: 2000 })
    // Each scheduled step, the first and the settling one each ask.
    expect(steps.mock.calls.length).toBeGreaterThan(0)
    expect(tres.invalidate.mock.calls.length).toBeGreaterThan(steps.mock.calls.length)
  })

  it('asks for a frame as the arm unstows with the sol clock', async () => {
    const { set } = sunCrossings()
    const fulls = copiesOf('full')
    const rover = await mountRover(
      Promise.resolve(models.full),
      Promise.resolve(models['low-poly']),
      { joints: armPoseAt(set) },
    )
    await vi.waitFor(() => expect(fulls()[0]?.visible).toBe(true), { timeout: 2000 })
    const arm = ['arm_1', 'arm_2', 'arm_3', 'arm_4', 'arm_5'].map((name) =>
      fulls()[0]!.getObjectByName(name)!,
    )
    for (const seconds of [30, 60, 90, 120]) {
      const before = arm.map((node) => node.quaternion.clone())
      tres.invalidate.mockClear()
      await rover.setProps({ joints: armPoseAt(set + seconds / MARS_SOL_SECONDS) })
      expect(tres.invalidate).toHaveBeenCalled()
      expect(
        Math.max(...arm.map((node, k) => node.quaternion.angleTo(before[k]!))),
      ).toBeGreaterThan(0)
    }
  })
})

describe('the rover steering its corner wheels', () => {
  const STEER_NODES = ['steer_lf', 'steer_rf', 'steer_lr', 'steer_rr'] as const
  const STEER_FIELDS = ['steerFL', 'steerFR', 'steerRL', 'steerRR'] as const

  /** The rover standing still at the origin, its corner wheels at `angles` (FL, FR, RL, RR). */
  function steered(angles: readonly number[]): Float32Array {
    const frame = flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 })
    for (const [k, name] of STEER_FIELDS.entries())
      frame[KEYFRAME_FIELDS.indexOf(name)] = angles[k]!
    return frame
  }

  /** How far `copy`'s node `name` has turned from the model's rest about the body's up axis, counter-clockwise. */
  function steerOf(file: RoverModelFile, copy: Object3D, name: string): number {
    const rest = models[file].scene.getObjectByName(name)!.quaternion.clone().invert()
    const forward = new Vector3(1, 0, 0).applyQuaternion(
      rest.multiply(copy.getObjectByName(name)!.quaternion),
    )
    return Math.atan2(forward.y, forward.x)
  }

  it('turns the full model and the stand-in alike to the frame angles, asking for a frame at each change', async () => {
    const standins = copiesOf('low-poly')
    const fulls = copiesOf('full')
    const rover = await mountRover(
      Promise.resolve(models.full),
      Promise.resolve(models['low-poly']),
      {
        frame: steered([0, 0, 0, 0]),
        joints: {},
      },
    )
    await vi.waitFor(() => expect(castsOnly(standins()[0]!)).toBe(true), { timeout: 2000 })
    const copies = { 'full': fulls()[0]!, 'low-poly': standins()[0]! }
    // Standing still, as the wheels steer before a turn: only the angles change between frames.
    const stances = [
      [-0.84, 0.84, 0.79, -0.79],
      [0.9, 0.35, -0.8, -0.33],
      [0, 0, 0, 0],
    ]
    for (const angles of stances) {
      tres.invalidate.mockClear()
      await rover.setProps({ frame: steered(angles) })
      expect(tres.invalidate).toHaveBeenCalled()
      for (const [file, copy] of Object.entries(copies) as [RoverModelFile, Object3D][]) {
        const read = STEER_NODES.map((name) => steerOf(file, copy, name))
        expect([file, ...read]).toEqual([file, ...angles.map((a) => expect.closeTo(a, 5))])
      }
    }
  })
})

describe('death ghosts', () => {
  it('draw the low-poly model in the ghost look, casting no shadow', async () => {
    loads.next = (file) =>
      file === 'low-poly' ? Promise.resolve(models['low-poly']) : new Promise(() => {})
    const ghosts = copiesOf('low-poly')
    await mountSuspended(DeathGhosts, {
      props: { deaths: [{ x: 1, y: 2, z: 0, headingRad: 0.5, id: 'death-1' }] },
    })
    await flushPromises()
    expect(ghosts()).toHaveLength(1)
    for (const mesh of meshes(ghosts()[0]!)) {
      expect(mesh.material).toBe(roverLookMaterial('ghost'))
      expect([mesh.castShadow, mesh.receiveShadow]).toEqual([false, false])
    }
  })
})
