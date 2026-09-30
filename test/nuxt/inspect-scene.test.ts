import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { Group } from 'three'
import { PerspectiveCamera } from 'three'
import type { DestinationObject } from '#shared/utils/client'
import { destinationObject } from '#shared/utils/client'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import DiskScene from '~/components/scene/DiskScene.vue'

/** What the picker reads from the canvas it would sit in: the camera and the drawing surface. */
const tres = vi.hoisted(() => ({
  camera: { value: undefined as unknown },
  renderer: { domElement: undefined as unknown as HTMLCanvasElement },
}))

vi.mock('@tresjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tresjs/core')>()),
  useTres: () => tres,
  useLoop: () => ({ onBeforeRender: () => {} }),
}))

// The canvas needs WebGL: the scene is stood in for by its picker alone, raycasting for real.
vi.mock('~/components/scene/StopScene.vue', async () => {
  const vue = await import('vue')
  // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
  const picker = (await import('~/components/scene/ScenePicker.vue')).default
  return {
    default: vue.defineComponent({
      name: 'StopScene',
      props: ['pickables', 'focusTarget'],
      emits: ['hover', 'tap'],
      setup:
        (props, { emit }) =>
        () =>
          vue.h(
            'div',
            { 'data-test': 'stop-scene', 'data-focus': JSON.stringify(props.focusTarget) },
            [
              vue.h(picker, {
                pickables: props.pickables,
                rover: { x: 0, y: 0, z: 0 },
                onHover: (...args: unknown[]) => emit('hover', ...args),
                onTap: (...args: unknown[]) => emit('tap', ...args),
              }),
            ],
          ),
    }),
  }
})

/** The canvas is a 400 × 400 px box whose corner sits at client (10, 20). */
const BOX = { left: 10, top: 20, width: 400, height: 400 }

const STARTED = '2026-09-26T09:00:00.000Z'
/** The drive from stop 2 at (0, 0) to its flag 30 m east and 40 m north. */
const DESTINATION: DestinationObject = destinationObject(
  {
    currentStop: { index: 2, x: 0, y: 0 },
    trail: [{ x: 0, y: 0 }],
    segment: {
      id: 'seg-4',
      startedAt: STARTED,
      submitter: { displayName: 'Grace', avatarUrl: null },
      plan: { pathLengthM: 57, estimatedMinutes: 38 },
    },
  },
  [
    { x: 0, y: 0 },
    { x: 30, y: 40 },
  ],
)!
const ARRIVAL = new Date(Date.parse(STARTED) + 38 * 60_000).toLocaleTimeString(undefined, {
  hour: '2-digit',
  minute: '2-digit',
})

/** The ground's height everywhere: the flag's foot. */
const GROUND_Z = 3

function grid(size: number) {
  return {
    heights: new Float32Array(size * size).fill(GROUND_Z),
    width: size,
    height: size,
    cellSize: 1,
  }
}

async function mountScene() {
  const wrapper = await mountSuspended(DiskScene, {
    props: {
      terrain: { grid: grid(129), origin: { i: -64, j: -64 } },
      chunkVertices: 65,
      heightAt: () => GROUND_Z,
      rest: { x: 0, y: 0, headingRad: 0 },
      objects: [DESTINATION],
    },
  })
  await flushPromises()
  // The renderer brings world matrices up to date every frame; nothing renders here.
  const picker = wrapper.findComponent({ name: 'ScenePicker' }).vm as unknown as { root: Group }
  picker.root.updateMatrixWorld()
  return wrapper
}

/**
 * A mouse over the canvas at `dx`, `dy` pixels from its middle. The camera, 10 m south of the
 * flag and level with its middle, sees 0.43 m per 20 px there (a 50° field over 400 px).
 */
function pointer(type: string, dx: number, dy: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    clientX: BOX.left + BOX.width / 2 + dx,
    clientY: BOX.top + BOX.height / 2 + dy,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 0,
  })
}

const PX_PER_M = BOX.height / 2 / (10 * Math.tan((25 * Math.PI) / 180))

const card = () => document.body.querySelector<HTMLElement>('[data-test=object-card]')

async function hover(dx: number, dy: number): Promise<void> {
  tres.renderer.domElement.dispatchEvent(pointer('pointermove', dx, dy))
  await vi.waitFor(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await flushPromises()
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: BOX.left,
    y: BOX.top,
    right: BOX.left + BOX.width,
    bottom: BOX.top + BOX.height,
    toJSON: () => ({}),
  })
  const middle = GROUND_Z + 1.1
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000)
  camera.up.set(0, 0, 1)
  camera.position.set(DESTINATION.x, DESTINATION.y - 10, middle)
  camera.lookAt(DESTINATION.x, DESTINATION.y, middle)
  camera.updateMatrixWorld()
  tres.camera.value = camera
  tres.renderer.domElement = document.createElement('canvas')
  document.body.append(tres.renderer.domElement)
})

afterEach(() => {
  useMapFocus().clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe("the destination's flag in 3D", () => {
  it('shows its card on hover: the author, where it lies, the route and the planned arrival', async () => {
    await mountScene()
    await hover(0, 0)
    expect(card()?.dataset.kind).toBe('destination')
    const text = card()?.textContent ?? ''
    expect(text).toContain('Destination')
    expect(card()?.querySelector('[data-test=object-card-author]')?.textContent).toContain('Grace')
    expect(text).toContain('50 m · 37° NE from stop 2')
    expect(text).toContain('57 m path · 38 min')
    expect(text).toContain(`Arrival ${ARRIVAL}, planned`)
  })

  it("is picked within the flag's reach: its pole's height and its cloth's width", async () => {
    await mountScene()
    // The pole is 2.2 m tall: 1 m above its middle is on it, 1.3 m is over its top.
    await hover(0, -1 * PX_PER_M)
    expect(card()?.dataset.kind).toBe('destination')
    await hover(0, -1.3 * PX_PER_M)
    expect(card()).toBeNull()
    // The cloth reaches 0.74 m from the pole, to whichever side it turns.
    await hover(0.6 * PX_PER_M, 0)
    expect(card()?.dataset.kind).toBe('destination')
    await hover(1 * PX_PER_M, 0)
    expect(card()).toBeNull()
  })

  it('focuses it on a click, the camera turning to its middle', async () => {
    const wrapper = await mountScene()
    const canvas = tres.renderer.domElement
    canvas.dispatchEvent(pointer('pointerdown', 0, 0))
    canvas.dispatchEvent(pointer('pointerup', 0, 0))
    await flushPromises()
    expect(useMapFocus().focused.value).toBe('destination:seg-4')
    const focus = JSON.parse(wrapper.find('[data-test=stop-scene]').attributes('data-focus')!)
    expect(focus).toEqual({ x: 30, y: 40, z: GROUND_Z + 1 })
  })
})
