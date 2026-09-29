import { describe, expect, it } from 'vitest'
import type { Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three'
import { BoxGeometry, Group, Mesh as ThreeMesh } from 'three'
import { ROVER_PAINT, SCENE_COLORS } from '#shared/utils/client/scene/palette'
import {
  applyRoverLook,
  GHOST_OPACITY,
  ROVER_LOOKS,
  roverLookMaterial,
} from '#shared/utils/client/scene/rover-looks'

/** Two copies of a two-mesh model sharing one geometry, as clones of a loaded model do. */
function copies(): { roots: Group[]; meshes: Mesh[] } {
  const geometry = new BoxGeometry()
  const roots = [0, 1].map(() => {
    const root = new Group()
    root.add(new ThreeMesh(geometry), new ThreeMesh(geometry))
    return root
  })
  return { roots, meshes: roots.flatMap((root) => root.children as Mesh[]) }
}

describe('rover looks', () => {
  it('returns one material per look, the same one on every call', () => {
    const [ghost, standin] = ROVER_LOOKS.map((look) => roverLookMaterial(look))
    expect(ghost).not.toBe(standin)
    for (const look of ROVER_LOOKS) expect(roverLookMaterial(look)).toBe(roverLookMaterial(look))
  })

  it('draws a ghost as the red translucent unlit tint, without shadows', () => {
    const { roots, meshes } = copies()
    for (const root of roots) applyRoverLook(root, 'ghost')
    const material = roverLookMaterial('ghost') as MeshBasicMaterial
    expect(material.isMeshBasicMaterial).toBe(true)
    expect(material.color.getHexString()).toBe(SCENE_COLORS.death.slice(1))
    expect(material).toMatchObject({
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      toneMapped: false,
    })
    for (const mesh of meshes) {
      expect(mesh.material).toBe(material)
      expect([mesh.castShadow, mesh.receiveShadow]).toEqual([false, false])
    }
  })

  it('draws a stand-in opaque and lit in the paint, casting and receiving shadows, fogged', () => {
    const { roots, meshes } = copies()
    for (const root of roots) applyRoverLook(root, 'standin')
    const material = roverLookMaterial('standin') as MeshStandardMaterial
    expect(material.isMeshStandardMaterial).toBe(true)
    expect(material.color.getHexString()).toBe(ROVER_PAINT.slice(1))
    expect(material.transparent).toBe(false)
    expect(material.fog).toBe(true)
    expect(material.metalness).toBeGreaterThan(0)
    expect(material.metalness).toBeLessThan(0.5)
    for (const mesh of meshes) {
      expect(mesh.material).toBe(material)
      expect([mesh.castShadow, mesh.receiveShadow]).toEqual([true, true])
    }
    // The copies share their geometry as loaded.
    expect(meshes[0]!.geometry).toBe(meshes[2]!.geometry)
  })
})
