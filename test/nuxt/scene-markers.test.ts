import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Group, InstancedMesh, Object3D } from 'three'
import { Color } from 'three'
import { SCENE_COLORS } from '#shared/utils/client/scene'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import GoalMarkers from '~/components/scene/GoalMarkers.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import TrailLayer from '~/components/scene/TrailLayer.vue'

/** The group a scene layer draws into: the object of its `<primitive>`. */
const rootOf = (wrapper: { vm: unknown }) => (wrapper.vm as { root: Group }).root

const byName = (root: Object3D, name: string) =>
  root.children.find((child) => child.name === name) as InstancedMesh | undefined

describe('TrailLayer', () => {
  const stops = [
    { x: 0, y: 0 },
    { x: 12, y: 3 },
    { x: 20, y: -4, current: true },
  ]

  it('draws one post and one head per stop, the current head in the accent', async () => {
    const wrapper = await mountSuspended(TrailLayer, {
      props: { stops, groundAt: (x: number) => x / 10 },
    })
    const root = rootOf(wrapper)
    const posts = byName(root, 'posts')!
    const heads = byName(root, 'heads')!
    expect(posts.count).toBe(3)
    expect(heads.count).toBe(3)
    expect(byName(root, 'contacts')!.count).toBe(3)
    const color = new Color()
    heads.getColorAt(2, color)
    expect(color.getHexString()).toBe(new Color(SCENE_COLORS.marker.sphere.current).getHexString())
    heads.getColorAt(0, color)
    expect(color.getHexString()).toBe(new Color(SCENE_COLORS.marker.sphere.past).getHexString())
  })

  it('draws no posts without stops', async () => {
    const wrapper = await mountSuspended(TrailLayer, { props: { stops: [] } })
    expect(byName(rootOf(wrapper), 'posts')).toBeUndefined()
  })
})

describe('GoalMarkers', () => {
  const destination = { x: 30, y: 40, z: 2, approach: { x: 30, y: 30 } }

  it('flies one flag at the destination', async () => {
    const wrapper = await mountSuspended(GoalMarkers, { props: { destination } })
    const flags = rootOf(wrapper).children
    expect(flags.map((flag) => flag.name)).toEqual(['flag:destination'])
    expect(flags[0]!.position.toArray()).toEqual([30, 40, 2])
  })

  it('adds a smaller flag per goal beside the destination', async () => {
    const wrapper = await mountSuspended(GoalMarkers, {
      props: {
        destination,
        goals: [{ id: 'submission:a', x: 5, y: 5, z: 0 }],
        from: { x: 0, y: 0 },
      },
    })
    expect(rootOf(wrapper).children.map((flag) => flag.name)).toEqual([
      'flag:destination',
      'flag:goal',
    ])
  })
})
