import type { Material, Mesh, Object3D } from 'three'
import { MeshBasicMaterial, MeshStandardMaterial } from 'three'
import { ROVER_PAINT, SCENE_COLORS } from './palette'

/**
 * How a copy of the low-poly rover is drawn: `ghost`, the red translucent silhouette of a death
 * marker; `standin`, the rover in its paint, lit and shadowed like the full model, drawn until the
 * full model is in or when it cannot load. Closed set.
 */
export type RoverLook = 'ghost' | 'standin'

export const ROVER_LOOKS: readonly RoverLook[] = ['ghost', 'standin']

/** A ghost's opacity; see-through enough that the ground under it reads. */
export const GHOST_OPACITY = 0.3

const materials = new Map<RoverLook, Material>()

function create(look: RoverLook): Material {
  if (look === 'ghost') {
    return new MeshBasicMaterial({
      color: SCENE_COLORS.death,
      // Unlit and not tone mapped, like the death disc under it: the token's red at any exposure.
      toneMapped: false,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    })
  }
  return new MeshStandardMaterial({ color: ROVER_PAINT, metalness: 0.15, roughness: 0.6 })
}

/**
 * The material of `look`, made on first use and shared by every copy drawn in it: callers never
 * change or dispose it.
 */
export function roverLookMaterial(look: RoverLook): Material {
  let material = materials.get(look)
  if (!material) {
    material = create(look)
    materials.set(look, material)
  }
  return material
}

/**
 * Draws every mesh of `object`, a copy of the low-poly rover, in `look`: its material, and shadows
 * cast and received by the stand-in only (a ghost's shadow would darken the ground it marks).
 */
export function applyRoverLook(object: Object3D, look: RoverLook): void {
  const material = roverLookMaterial(look)
  const shadowed = look === 'standin'
  object.traverse((child) => {
    child.castShadow = child.receiveShadow = shadowed
    const mesh = child as Mesh
    if (mesh.isMesh) mesh.material = material
  })
}
