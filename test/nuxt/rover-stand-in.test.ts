import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { Material, Mesh, Object3D } from 'three'
import { Quaternion, Vector3 } from 'three'
import { ARM_NIGHT, rigTransforms, ROVER_RIG_NODES } from '#shared/utils/client/scene'
import { roverLookMaterial } from '#shared/utils/client/scene/rover-looks'
import type { LoadedRoverModel, RoverModelFile } from '~/utils/rover-model'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DeathGhosts from '~/components/scene/DeathGhosts.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverModel from '~/components/scene/RoverModel.vue'
import { motionAt } from '~~/modules/dev/runtime/app/playground/rover-motion'

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

/** A point turn's steering phase with the arm in its night pose. */
const motion = motionAt('point-turn', 25)
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

/** Each joint of `copy` turned as the frame and `joints` say, from the model's own rests. */
function expectPosed(file: RoverModelFile, copy: Object3D): void {
  const rest = models[file].scene
  const rig = rigTransforms(motion.frame).joints
  for (const name of ROVER_RIG_NODES) {
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

async function mountRover(full: Promise<LoadedRoverModel>, lowPoly: Promise<LoadedRoverModel>) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  loads.next = (file) => (file === 'full' ? full : lowPoly)
  const rover = await mountSuspended(RoverModel, {
    props: { frame: motion.frame, joints },
  })
  await flushPromises()
  return rover
}

describe('the rover while its full model loads', () => {
  it('draws the stand-in first, posed by the frame, the steering and the arm night pose', async () => {
    expect(Math.abs(motion.joints.steer_lf!)).toBeGreaterThan(0.1)
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

  it('crossfades to the full model once decoded, leaving only the full model', async () => {
    const full = deferred<LoadedRoverModel>()
    const standins = copiesOf('low-poly')
    const fulls = copiesOf('full')
    const rover = await mountRover(full.promise, Promise.resolve(models['low-poly']))
    const root = standins()[0]!.parent!

    full.resolve(models.full)
    await flushPromises()
    await vi.waitFor(() => expect(modelsUnder(root)).toEqual([fulls()[0]]), { timeout: 2000 })
    const model = fulls()[0]!
    expect(model.visible).toBe(true)
    expect(standins()[0]!.parent).toBeNull()
    // Back on the model's own materials once the fade is over.
    const own = new Set(meshes(models.full.scene).map((mesh) => mesh.material as Material))
    for (const mesh of meshes(model)) expect(own.has(mesh.material as Material)).toBe(true)
    expectPosed('full', model)
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
