import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { Mesh, MeshStandardMaterial, Object3D } from 'three'
import { ROVER_RIG_NODES } from '#shared/utils/client/scene'
import { ARM_JOINTS, ARM_STOWED } from '#shared/utils/rover'
import { loadRoverModel } from '~/utils/rover-model'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverJoints3D from '~~/modules/dev/runtime/app/components/playground/RoverJoints3D.vue'

/** Tests run from the repository root. */
const MODEL = join(process.cwd(), 'public/models/rover/rover.glb')

// The page's scene needs WebGL; the page itself only needs the model's joints.
vi.mock('~~/modules/dev/runtime/app/components/playground/RoverJointsScene.vue', async () => {
  const vue = await import('vue')
  return {
    __esModule: true,
    default: vue.defineComponent({ name: 'RoverJointsScene', render: () => null }),
  }
})

/** `rover.glb` from the public folder, as the page's fetch would get it. */
function serveModel(): void {
  const bytes = readFileSync(MODEL)
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes)))
}

const jointNodes = (model: Object3D) => {
  const names: string[] = []
  model.traverse((node) => {
    if ((node.userData as { joint?: string }).joint) names.push(node.name)
  })
  return names
}

describe('the rover model', () => {
  it('exposes the rig, steering, mast and arm joints, the differential rods and the turret lamp anchor', async () => {
    serveModel()
    const { scene } = await loadRoverModel('/')
    const joints = jointNodes(scene)
    expect(joints).toEqual(expect.arrayContaining([...ROVER_RIG_NODES]))
    expect(joints).toEqual(
      expect.arrayContaining([
        'steer_lf',
        'steer_rf',
        'steer_lr',
        'steer_rr',
        'mast_azimuth',
        'mast_elevation',
      ]),
    )
    for (const side of ['left', 'right']) {
      const rod = scene.getObjectByName(`${side}_differential_link`)
      expect(rod?.parent?.name).toBe('differential')
      expect((rod!.userData as { aim?: { node: string } }).aim?.node).toBe(`${side}_rocker`)
    }
    // The arm's five joints from the shoulder out, the turret's lamp on the last.
    expect(joints).toEqual(expect.arrayContaining(ARM_JOINTS.map((j) => j.node)))
    let parent = 'chassis'
    for (const { node, urdf, limit } of ARM_JOINTS) {
      const arm = scene.getObjectByName(node)!
      expect(arm.parent?.name).toBe(parent)
      expect(arm.userData).toMatchObject({
        joint: urdf,
        limit: [...limit],
        baked: ARM_STOWED[node],
      })
      parent = node
    }
    expect(scene.getObjectByName('turret')?.parent?.name).toBe('arm_5')
  })

  it('draws each part in one baked material and its glass in another, 35 draw calls at most', async () => {
    serveModel()
    const { scene } = await loadRoverModel('/')
    const meshes: Mesh[] = []
    scene.traverse((node) => {
      if ((node as Mesh).isMesh) meshes.push(node as Mesh)
    })
    expect(meshes.length).toBeLessThanOrEqual(35)
    const materials = [...new Set(meshes.map((m) => m.material as MeshStandardMaterial))]
    expect(materials.every((m) => m.isMeshStandardMaterial)).toBe(true)
    // Colour, roughness and metalness come from the atlas pages, the factors stay at one.
    const opaque = materials.filter((m) => !m.transparent)
    expect(opaque.map((m) => m.name).sort()).toEqual([
      'arm',
      'chassis 1',
      'chassis 2',
      'chassis 3',
      'mast',
      'suspension',
      'wheels',
    ])
    for (const m of opaque) expect([m.metalness, m.roughness]).toEqual([1, 1])
    // The glass's opacity per pane is its texture's alpha.
    const glass = materials.filter((m) => m.transparent)
    expect(glass.map((m) => m.name).sort()).toEqual(['arm glass', 'chassis glass', 'mast glass'])
    for (const m of glass) expect(m.opacity).toBe(1)
  })
})

describe('the rover joints preview', () => {
  it('lists one slider per joint node found in the model', async () => {
    serveModel()
    const { scene } = await loadRoverModel('/')
    const page = await mountSuspended(RoverJoints3D)
    await vi.waitFor(async () => {
      await flushPromises()
      expect(page.findAll('[data-testid="joint-slider"]').length).toBeGreaterThan(0)
    })
    const labels = page.findAll('[data-testid="joint-slider"]').map((row) => row.text())
    const joints = jointNodes(scene)
    expect(labels).toHaveLength(joints.length)
    joints.forEach((name, k) => expect(labels[k]).toContain(name))
  })
})
