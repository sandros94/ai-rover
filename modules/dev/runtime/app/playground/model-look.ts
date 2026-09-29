import type { Ref } from 'vue'
import { onBeforeUnmount, watch } from 'vue'
import type { Material, Mesh, Object3D } from 'three'

/** Solid, see-through, or edges only: the linkage inside the body shows in the last two. */
export type ModelLook = 'solid' | 'x-ray' | 'wireframe'
export const MODEL_LOOKS: readonly ModelLook[] = ['solid', 'x-ray', 'wireframe']

type Saved = Partial<Record<'transparent' | 'opacity' | 'depthWrite' | 'wireframe', unknown>>

/**
 * Draws `model` in `look` by changing its materials in place: the loaded model's materials are
 * the ones every copy of it draws with, so a scene's own copy follows. They are put back as
 * loaded when the component unmounts.
 */
export function useModelLook(model: Ref<Object3D | undefined>, look: Ref<ModelLook>): void {
  const saved = new Map<Material, Saved>()
  watch([look, model], ([mode, object]) => {
    object?.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return
      for (const material of [mesh.material].flat() as (Material & { wireframe?: boolean })[]) {
        if (!saved.has(material)) {
          const { transparent, opacity, depthWrite, wireframe } = material
          saved.set(material, { transparent, opacity, depthWrite, wireframe })
        }
        Object.assign(material, saved.get(material))
        if (mode === 'x-ray') {
          Object.assign(material, { transparent: true, opacity: 0.25, depthWrite: false })
        }
        if (mode === 'wireframe') material.wireframe = true
        material.needsUpdate = true
      }
    })
  })
  onBeforeUnmount(() => {
    for (const [material, state] of saved) Object.assign(material, state, { needsUpdate: true })
  })
}
