import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { Mesh, MeshStandardMaterial, Object3D } from 'three'
import { ROVER_RIG_NODES } from '#shared/utils/client/scene'
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
  it('exposes the rig, steering and mast joints, the differential rods and the turret lamp anchor', async () => {
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
    expect(scene.getObjectByName('turret')?.parent?.name).toBe('chassis')
  })

  it('draws with its own materials: metals, and the camera glass blended', async () => {
    serveModel()
    const { scene } = await loadRoverModel('/')
    const materials = new Set<MeshStandardMaterial>()
    scene.traverse((node) => {
      if ((node as Mesh).isMesh) materials.add((node as Mesh).material as MeshStandardMaterial)
    })
    const all = [...materials]
    expect(all.every((m) => m.isMeshStandardMaterial)).toBe(true)
    expect(all.some((m) => m.metalness === 1 && m.roughness < 0.5)).toBe(true)
    const glass = all.filter((m) => m.name === 'glass lens')
    expect(glass).toHaveLength(1)
    expect(glass[0]!.transparent).toBe(true)
    expect(glass[0]!.opacity).toBeCloseTo(0.3, 3)
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
