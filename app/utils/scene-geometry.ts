import { BufferAttribute, BufferGeometry } from 'three'
import type { OverlayMesh } from '#shared/utils/client/scene'

/** An overlay's buffers as a three.js geometry; the caller places the mesh at `mesh.origin`. */
export function overlayGeometry(mesh: Pick<OverlayMesh, 'positions' | 'indices'>): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}
