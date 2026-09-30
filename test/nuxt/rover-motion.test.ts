import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { framePlacement } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoverMotion3D from '~~/modules/dev/runtime/app/components/playground/RoverMotion3D.vue'
import { PLAYGROUND_ENTRIES } from '~~/modules/dev/runtime/app/playground/registry'

// The page's scene needs WebGL; the page itself only feeds it.
vi.mock('~~/modules/dev/runtime/app/components/playground/RoverJointsScene.vue', async () => {
  const vue = await import('vue')
  return {
    __esModule: true,
    default: vue.defineComponent({
      name: 'RoverJointsScene',
      props: ['frame', 'joints', 'heightAt', 'solFraction', 'lamp'],
      render: () => null,
    }),
  }
})
// The model is loaded only for the look toggle; the page works without it.
vi.mock('~/utils/rover-model', () => ({ loadRoverModel: () => new Promise(() => {}) }))

async function mountPage() {
  const page = await mountSuspended(RoverMotion3D)
  await vi.waitFor(async () => {
    await flushPromises()
    expect(page.findComponent({ name: 'RoverJointsScene' }).exists()).toBe(true)
  })
  const scene = () => page.findComponent({ name: 'RoverJointsScene' })
  const scrub = async (t: number) => {
    page.findComponent({ name: 'USlider' }).vm.$emit('update:modelValue', t)
    await flushPromises()
  }
  const pick = async (demo: string) => {
    page.findComponent({ name: 'UTabs' }).vm.$emit('update:modelValue', demo)
    await flushPromises()
  }
  return { page, scene, scrub, pick }
}

describe('the rover motion playground', () => {
  it('is a scene entry of its own', () => {
    const entry = PLAYGROUND_ENTRIES.find((e) => e.id === 'rover-motion')
    expect(entry).toMatchObject({ group: 'scene', needs: [] })
  })

  it('lists the three demos', async () => {
    const { page } = await mountPage()
    const tabs = page.find('[data-testid="motion-demos"]').text()
    for (const title of ['Point turn', 'Arc', 'Dusk and dawn']) expect(tabs).toContain(title)
  })

  it('scrubs the point turn through the steering, the arc along its path and twilight through the arm', async () => {
    const { scene, scrub, pick } = await mountPage()
    const joints = () => ({ ...(scene().props('joints') as Record<string, number>) })
    const steerFL = () =>
      (scene().props('frame') as Float32Array)[KEYFRAME_FIELDS.indexOf('steerFL')]!

    await scrub(0)
    expect(steerFL()).toBeCloseTo(0, 12)
    await scrub(25)
    // Counter-clockwise positive: the front left toes in to the right.
    expect(steerFL()).toBeLessThan(-0.5)

    await pick('arc')
    const before = framePlacement(scene().props('frame') as Float32Array).position
    await scrub(60)
    const after = framePlacement(scene().props('frame') as Float32Array).position
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1)

    await pick('dusk-dawn')
    const stowed = joints()
    await scrub(120)
    const lifting = joints()
    for (const node of ['arm_1', 'arm_3']) expect(lifting[node]).not.toBe(stowed[node])
  })
})
