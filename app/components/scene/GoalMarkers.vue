<script setup lang="ts">
import { BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, Mesh } from 'three'
import { MeshBasicMaterial, MeshLambertMaterial } from 'three'
import { SCENE_COLORS } from '#shared/utils/client/scene'

/**
 * The open round's destinations in the scene: a thin pole at each goal with a small flag, the
 * focused one in the highlight colour.
 */
const props = withDefaults(
  defineProps<{
    goals: readonly { id: string; x: number; y: number; z: number }[]
    focusedId?: string | null
  }>(),
  { focusedId: null },
)

/** Metres. */
const POLE = { radius: 0.04, height: 2.2 }
const FLAG = { width: 0.8, height: 0.5 }

const poleGeometry = new CylinderGeometry(POLE.radius, POLE.radius, POLE.height, 6)
poleGeometry.rotateX(Math.PI / 2)
poleGeometry.translate(0, 0, POLE.height / 2)
/** A triangle off the pole's top, pointing east. */
const flagGeometry = new BufferGeometry()
flagGeometry.setAttribute(
  'position',
  new BufferAttribute(
    new Float32Array([
      0,
      0,
      POLE.height,
      0,
      0,
      POLE.height - FLAG.height,
      FLAG.width,
      0,
      POLE.height - FLAG.height / 2,
    ]),
    3,
  ),
)
const poleMaterial = new MeshLambertMaterial({ color: SCENE_COLORS.stop })
const flagMaterial = new MeshBasicMaterial({ color: SCENE_COLORS.goal, side: DoubleSide })
const focusedFlag = new MeshBasicMaterial({ color: SCENE_COLORS.focus, side: DoubleSide })

const root = new Group()
watch(
  () => [props.goals, props.focusedId] as const,
  ([goals, focusedId]) => {
    root.clear()
    for (const goal of goals) {
      const marker = new Group()
      marker.position.set(goal.x, goal.y, goal.z)
      marker.add(new Mesh(poleGeometry, poleMaterial))
      marker.add(new Mesh(flagGeometry, goal.id === focusedId ? focusedFlag : flagMaterial))
      root.add(marker)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  root.clear()
  poleGeometry.dispose()
  flagGeometry.dispose()
  poleMaterial.dispose()
  flagMaterial.dispose()
  focusedFlag.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
