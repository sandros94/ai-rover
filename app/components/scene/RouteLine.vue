<script setup lang="ts">
import { Mesh, MeshBasicMaterial } from 'three'
import { drapePath, ribbonMesh, SCENE_COLORS } from '#shared/utils/client/scene'
import { overlayGeometry } from '~/utils/scene-geometry'

const props = defineProps<{
  /** The planned route in world metres. */
  route: { x: number; y: number }[]
  heightAt?: (x: number, y: number) => number | undefined
}>()

/** A narrow strip rather than a GL line: line widths above one pixel are not portable. */
const STRIP = { widthM: 0.3, liftM: 0.12 }
const DRAPE_SPACING_M = 1

const material = new MeshBasicMaterial({
  color: SCENE_COLORS.route,
  polygonOffset: true,
  polygonOffsetFactor: -3,
})
const mesh = new Mesh(undefined, material)

watch(
  () => [props.route, props.heightAt],
  () => {
    const heightAt = props.heightAt ?? (() => undefined)
    const strip = ribbonMesh(drapePath(props.route, heightAt, { spacingM: DRAPE_SPACING_M }), STRIP)
    mesh.geometry.dispose()
    mesh.geometry = overlayGeometry(strip)
    mesh.position.set(strip.origin.x, strip.origin.y, strip.origin.z)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mesh.geometry.dispose()
  material.dispose()
})
</script>

<template>
  <primitive :object="mesh" />
</template>
