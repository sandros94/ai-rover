import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { BufferAttribute, Group, Mesh } from 'three'
import { computed, defineComponent, h, nextTick, shallowRef } from 'vue'
import { createDiskGround, groundView } from '#shared/utils/client'
import { generateChunk, revealedOverDisk } from '#shared/utils/terrain'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DiskScene from '~/components/scene/DiskScene.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import TerrainChunks from '~/components/scene/TerrainChunks.vue'
import { useRevealFade } from '~/composables/useRevealFade'
import { journeyFixture } from '../unit/client/helpers'

// The canvas needs WebGL; the terrain layer alone draws into a plain group.
vi.mock('~/components/scene/StopScene.vue', async () => {
  const vue = await import('vue')
  // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
  const layer = (await import('~/components/scene/TerrainChunks.vue')).default
  return {
    default: vue.defineComponent({
      name: 'StopScene',
      props: ['chunks', 'heightRange', 'heightAt', 'fog', 'sight'],
      setup: (props) => () =>
        vue.h(layer, {
          chunks: props.chunks,
          heightRange: props.heightRange,
          heightAt: props.heightAt,
          fog: props.fog,
          sight: props.sight,
          focus: { x: 0, y: 0 },
        }),
    }),
  }
})

describe('DiskScene over ground still arriving', () => {
  it('draws a mesh per chunk in, keeping each as the rest arrives', async () => {
    const { stopManifest, world, mask } = journeyFixture()
    const ground = createDiskGround(stopManifest)
    const [southWest, southEast, northWest, northEast] = [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ].map(([cx, cy]) => generateChunk(world, { cx: cx!, cy: cy! }))
    ground.place(southWest!)
    ground.place(northEast!)
    const view = shallowRef(groundView(ground, stopManifest.heightRange))
    const wrapper = await mountSuspended(
      defineComponent({
        setup: () => {
          // Read with the view, as the stop's flags cover the ground arrived so far.
          const seen = computed(() => view.value && revealedOverDisk(mask, ground))
          const fade = useRevealFade(
            () => seen.value,
            () => view.value.grid,
          )
          return () =>
            h(DiskScene, {
              terrain: view.value,
              fog: { stopSeen: seen.value, fade: fade.value, sight: undefined },
              chunkVertices: 65,
              heightAt: () => 0,
              rest: { x: 0, y: 0, headingRad: 0 },
            })
        },
      }),
    )
    await nextTick()
    const root = (wrapper.findComponent(TerrainChunks).vm as unknown as { root: Group }).root
    const first = [...root.children] as Mesh[]
    const geometries = first.map((mesh) => mesh.geometry)
    expect(first).toHaveLength(2)

    ground.place(southEast!)
    ground.place(northWest!)
    view.value = groundView(ground, stopManifest.heightRange)
    await nextTick()
    await nextTick()
    expect(root.children).toHaveLength(4)
    expect(root.children.slice(0, 2)).toEqual(first)
    expect(root.children[0]).toBe(first[0])
    expect(root.children[1]).toBe(first[1])
    // Not rebuilt either: the meshes in keep the geometry they were drawn with.
    expect(first.map((mesh) => mesh.geometry)).toEqual(geometries)
    expect(first[0]!.geometry).toBe(geometries[0])
  })
})

describe("DiskScene as the rover's sight changes", () => {
  it('recolours the chunks in place: same geometry, colours rewritten, heights untouched', async () => {
    const { stopManifest, world, mask } = journeyFixture()
    const ground = createDiskGround(stopManifest)
    for (const [cx, cy] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ])
      ground.place(generateChunk(world, { cx: cx!, cy: cy! }))
    const seen = revealedOverDisk(mask, ground)
    const sight = shallowRef<Uint8Array>(new Uint8Array(seen.length))
    const view = groundView(ground, stopManifest.heightRange)
    const wrapper = await mountSuspended(
      defineComponent({
        setup: () => {
          const fade = useRevealFade(
            () => seen,
            () => view.grid,
          )
          return () =>
            h(DiskScene, {
              terrain: view,
              fog: { stopSeen: seen, fade: fade.value, sight: sight.value },
              chunkVertices: 65,
              heightAt: () => 0,
              rest: { x: 0, y: 0, headingRad: 0 },
            })
        },
      }),
    )
    await nextTick()
    const root = (wrapper.findComponent(TerrainChunks).vm as unknown as { root: Group }).root
    const meshes = [...root.children] as Mesh[]
    expect(meshes).toHaveLength(4)
    const geometries = meshes.map((mesh) => mesh.geometry)
    const attribute = (mesh: Mesh, name: string) =>
      mesh.geometry.getAttribute(name) as BufferAttribute
    const colors = meshes.map((mesh) => attribute(mesh, 'color'))
    const colorsBefore = colors.map((c) => Array.from(c.array))
    const positionVersions = meshes.map((mesh) => attribute(mesh, 'position').version)
    const colorVersions = colors.map((c) => c.version)

    // Everything revealed comes into sight.
    sight.value = seen.slice()
    await nextTick()
    await nextTick()
    expect(meshes.map((mesh) => mesh.geometry)).toEqual(geometries)
    meshes.forEach((mesh, k) => {
      expect(mesh.geometry).toBe(geometries[k])
      expect(attribute(mesh, 'color')).toBe(colors[k])
      expect(attribute(mesh, 'position').version).toBe(positionVersions[k])
    })
    // Every chunk holds revealed ground: each one is recoloured.
    colors.forEach((c, k) => {
      expect(c.version).toBeGreaterThan(colorVersions[k]!)
      expect(Array.from(c.array)).not.toEqual(colorsBefore[k])
    })
  })
})
