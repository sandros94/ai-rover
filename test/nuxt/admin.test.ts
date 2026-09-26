import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { clearNuxtData } from '#imports'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import AdminPage from '~/pages/admin.vue'

let configured = true
let answer: () => Response = () => new Response(null, { status: 500 })
const bodies: unknown[] = []

registerEndpoint('/api/admin/status', () => ({ configured }))
registerEndpoint('/api/admin/seed', {
  method: 'POST',
  handler: async (event) => {
    bodies.push(await event.req.json())
    return answer()
  },
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  clearNuxtData()
  configured = true
  bodies.length = 0
})

async function submit(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await wrapper.find('[data-test=admin-token] input').setValue('the-token')
  await wrapper.find('form').trigger('submit')
  for (let k = 0; k < 5; k++) await flushPromises()
}

describe('admin page', () => {
  it('renders the seeding form with its defaults', async () => {
    const wrapper = await mountSuspended(AdminPage)
    const token = wrapper.find<HTMLInputElement>('[data-test=admin-token] input')
    expect(token.attributes('type')).toBe('password')
    expect(wrapper.find<HTMLInputElement>('[data-test=admin-seed] input').element.value).toBe(
      'mars',
    )
    expect(wrapper.find<HTMLInputElement>('[data-test=admin-x] input').element.value).toBe('0')
    expect(wrapper.find<HTMLInputElement>('[data-test=admin-y] input').element.value).toBe('0')
    expect(wrapper.find('button[type=submit]').text()).toBe('Seed the mission')
    expect(wrapper.find('[data-test=admin-unconfigured]').exists()).toBe(false)
  })

  it('shows a notice and no form when the server has no admin token', async () => {
    configured = false
    const wrapper = await mountSuspended(AdminPage)
    expect(wrapper.find('[data-test=admin-unconfigured]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('posts the form and shows the landed mission', async () => {
    answer = () =>
      json(201, { missionId: 'm-1', stopId: 's-1', roundId: 'r-1', worldHash: '0123456789abcdef' })
    const wrapper = await mountSuspended(AdminPage)
    await submit(wrapper)
    expect(bodies).toEqual([{ token: 'the-token', seed: 'mars', x: 0, y: 0 }])
    expect(wrapper.find('[data-test=admin-result]').text()).toContain('m-1')
  })

  it('shows the refusal the server answered', async () => {
    answer = () => json(409, { status: 409, message: 'A mission already exists (m-0).' })
    const wrapper = await mountSuspended(AdminPage)
    await submit(wrapper)
    expect(wrapper.find('[data-test=admin-error]').text()).toContain('A mission already exists')
    expect(wrapper.find('[data-test=admin-result]').exists()).toBe(false)
  })
})
