<script setup lang="ts">
import { Group, Mesh, MeshBasicMaterial } from 'three'
import { flatFrame, groundDisc, SCENE_COLORS } from '#shared/utils/client/scene'
import type { FullModelLedger } from '#shared/utils/client/scene'
import { overlayGeometry } from '~/utils/scene-geometry'
import RoverModel from './RoverModel.vue'

const props = withDefaults(
  defineProps<{
    /** Where the rover died, facing its last heading; `z` is the ground there. */
    deaths: { x: number; y: number; z: number; headingRad: number; id?: string }[]
    heightAt?: (x: number, y: number) => number | undefined
    /** Radius of the red circle on the ground, metres. */
    radiusM?: number
    /** The focused death: its ghost gains the full model. */
    focusedId?: string | null
    ledger?: FullModelLedger
  }>(),
  { heightAt: undefined, radiusM: 3, focusedId: null, ledger: undefined },
)

const frames = computed(() => props.deaths.map((death) => flatFrame(death)))

const discs = new Group()
const material = new MeshBasicMaterial({
  color: SCENE_COLORS.death,
  toneMapped: false,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
})

function clear(): void {
  for (const child of discs.children) (child as Mesh).geometry.dispose()
  discs.clear()
}

watch(
  () => [props.deaths, props.heightAt, props.radiusM],
  () => {
    clear()
    const heightAt = props.heightAt ?? ((_x: number, _y: number) => undefined)
    for (const death of props.deaths) {
      const disc = groundDisc(death, (x, y) => heightAt(x, y) ?? death.z, {
        radiusM: props.radiusM,
        segments: 32,
        liftM: 0.08,
      })
      const mesh = new Mesh(overlayGeometry(disc), material)
      mesh.position.set(disc.origin.x, disc.origin.y, disc.origin.z)
      discs.add(mesh)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clear()
  material.dispose()
})
</script>

<template>
  <TresGroup>
    <primitive :object="discs" />
    <RoverModel
      v-for="(frame, k) in frames"
      :key="deaths[k]!.id ?? k"
      :frame="frame"
      :detailed="deaths[k]!.id !== undefined && deaths[k]!.id === focusedId"
      :ledger="ledger"
      ghost
    />
  </TresGroup>
</template>
