import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Group, Mesh } from 'three'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { createDiskGround, groundView } from '#shared/utils/client'
import { generateChunk, revealedOverDisk } from '#shared/utils/terrain'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DiskScene from '~/components/scene/DiskScene.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import TerrainChunks from '~/components/scene/TerrainChunks.vue'
import { journeyFixture } from '../unit/client/helpers'

// The canvas needs WebGL; the terrain layer alone draws into a plain group.
vi.mock('~/components/scene/StopScene.vue', async () => {
  const vue = await import('vue')
  // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
  const layer = (await import('~/components/scene/TerrainChunks.vue')).default
  return {
    default: vue.defineComponent({
      name: 'StopScene',
      props: ['chunks', 'heightRange', 'heightAt', 'fog'],
      setup: (props) => () =>
        vue.h(layer, {
          chunks: props.chunks,
          heightRange: props.heightRange,
          heightAt: props.heightAt,
          fog: props.fog,
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
        setup: () => () =>
          h(DiskScene, {
            terrain: view.value,
            seen: revealedOverDisk(mask, ground),
            chunkVertices: 65,
            heightAt: () => 0,
            rest: { x: 0, y: 0, headingRad: 0 },
          }),
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
