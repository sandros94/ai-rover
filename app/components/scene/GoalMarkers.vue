<script setup lang="ts">
import type { Material } from 'three'
import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three'
import type { FlagSize } from '#shared/utils/client/scene'
import { FLAG_MARKERS, flagYaw, SCENE_COLORS } from '#shared/utils/client/scene'

/**
 * Flags in the scene: the drive's destination in the accent colour, and the open round's goals
 * smaller and neutral, the focused one in the highlight colour. Each cloth faces the side it is
 * seen from: the destination the stretch of route leading to it, a goal the stop it was picked
 * from.
 */
const props = withDefaults(
  defineProps<{
    goals?: readonly { id: string; x: number; y: number; z: number }[]
    focusedId?: string | null
    /** Where the goals were picked from. */
    from?: { x: number; y: number }
    /** On the ground; `approach` is a point on the route leading to it. */
    destination?: { x: number; y: number; z: number; approach: { x: number; y: number } } | null
  }>(),
  { goals: () => [], focusedId: null, from: undefined, destination: null },
)

const { marker } = SCENE_COLORS

/** A pole standing on its foot and a cloth off its top towards +x; the flag turns about z. */
function flagGeometries(size: FlagSize) {
  const r = FLAG_MARKERS.poleRadiusM
  return {
    // Cylinders stand along their local y; the scene is z-up.
    pole: new CylinderGeometry(r, r, size.poleHeightM, 8)
      .rotateX(Math.PI / 2)
      .translate(0, 0, size.poleHeightM / 2),
    cloth: new PlaneGeometry(size.clothWidthM, size.clothHeightM)
      .rotateX(Math.PI / 2)
      .translate(r + size.clothWidthM / 2, 0, size.poleHeightM - size.clothHeightM / 2),
  }
}

const geometries = {
  destination: flagGeometries(FLAG_MARKERS.destination),
  goal: flagGeometries(FLAG_MARKERS.goal),
}
const poleMaterial = new MeshStandardMaterial({ color: marker.post, roughness: 0.85 })
// A faint glow and no fog keep a cloth readable far off.
const cloth = (color: string) =>
  new MeshStandardMaterial({
    color,
    roughness: 0.6,
    side: DoubleSide,
    emissive: color,
    emissiveIntensity: 0.08,
    fog: false,
  })
const clothMaterials = {
  destination: cloth(marker.flag.destination),
  goal: cloth(marker.flag.goal),
  focused: cloth(SCENE_COLORS.focus),
}

function flag(
  kind: keyof typeof geometries,
  material: Material,
  at: { x: number; y: number; z: number },
  from: { x: number; y: number },
): Group {
  const group = new Group()
  group.name = `flag:${kind}`
  group.position.set(at.x, at.y, at.z)
  group.rotation.z = flagYaw(at, from)
  group.add(new Mesh(geometries[kind].pole, poleMaterial))
  group.add(new Mesh(geometries[kind].cloth, material))
  return group
}

const root = new Group()
watch(
  () => [props.goals, props.focusedId, props.from, props.destination] as const,
  ([goals, focusedId, from, destination]) => {
    root.clear()
    if (destination) {
      root.add(flag('destination', clothMaterials.destination, destination, destination.approach))
    }
    for (const goal of goals) {
      const material = goal.id === focusedId ? clothMaterials.focused : clothMaterials.goal
      root.add(flag('goal', material, goal, from ?? goal))
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  root.clear()
  for (const { pole, cloth } of Object.values(geometries)) {
    pole.dispose()
    cloth.dispose()
  }
  poleMaterial.dispose()
  for (const material of Object.values(clothMaterials)) material.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
