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

let diagnosis: () => Response = () => new Response(null, { status: 500 })
const diagnoseBodies: unknown[] = []
registerEndpoint('/api/admin/diagnose', {
  method: 'POST',
  handler: async (event) => {
    diagnoseBodies.push(await event.req.json())
    return diagnosis()
  },
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  clearNuxtData()
  configured = true
  bodies.length = 0
  diagnoseBodies.length = 0
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

  it('runs diagnostics with the token and marks each section', async () => {
    diagnosis = () =>
      json(200, {
        database: {
          ok: false,
          error: 'DatabaseError (28P01)',
          ms: 12_004,
          migrations: [],
          tables: {},
        },
        locks: {
          ok: true,
          ms: 41,
          states: { 'active': 2, 'idle in transaction': 1 },
          oldestTransactionS: 93.25,
          stuck: [
            {
              pid: 4242,
              state: 'idle in transaction',
              waitEventType: null,
              ageS: 93.25,
              holdsAdvisoryLock: true,
            },
          ],
        },
        blobs: { ok: true, ms: 230, keys: 12 },
        mission: { ok: true, ms: 380, active: true, skipped: 'busy' },
        runtime: {
          node: 'v24.0.0',
          region: 'eu-central-1',
          hasSessionKey: true,
          hasTypesafeToken: true,
          originsConfigured: true,
        },
      })
    const wrapper = await mountSuspended(AdminPage)
    await wrapper.find('[data-test=admin-token] input').setValue('the-token')
    await wrapper.find('[data-test=admin-diagnose]').trigger('click')
    for (let k = 0; k < 5; k++) await flushPromises()

    expect(diagnoseBodies).toEqual([{ token: 'the-token' }])
    expect(bodies).toEqual([])
    const database = wrapper.find('[data-test=diagnosis-database]')
    expect(database.attributes('data-ok')).toBe('false')
    expect(database.text()).toContain('DatabaseError (28P01)')
    expect(database.text()).toContain('12004 ms')
    const locks = wrapper.find('[data-test=diagnosis-locks]')
    expect(locks.attributes('data-ok')).toBe('false')
    expect(locks.text()).toContain('idle in transaction 1')
    expect(locks.text()).toContain('Oldest transaction: 93.3 s')
    expect(locks.text()).toContain('pid 4242, idle in transaction, 93.3 s, holds an advisory lock')
    const mission = wrapper.find('[data-test=diagnosis-mission]')
    expect(mission.text()).toContain('another tick holds the mission lock')
    expect(mission.text()).toContain('380 ms')
    const blobs = wrapper.find('[data-test=diagnosis-blobs]')
    expect(blobs.attributes('data-ok')).toBe('true')
    expect(blobs.text()).toContain('12')
    const runtime = wrapper.find('[data-test=diagnosis-runtime]')
    expect(runtime.attributes('data-ok')).toBe('true')
    expect(runtime.text()).toContain('eu-central-1')
  })

  it('shows the refusal when diagnostics are refused', async () => {
    diagnosis = () => json(403, { status: 403, message: 'The admin token does not match.' })
    const wrapper = await mountSuspended(AdminPage)
    await wrapper.find('[data-test=admin-token] input').setValue('the-token')
    await wrapper.find('[data-test=admin-diagnose]').trigger('click')
    for (let k = 0; k < 5; k++) await flushPromises()
    expect(wrapper.find('[data-test=admin-error]').text()).toContain('does not match')
    expect(wrapper.find('[data-test=diagnosis-database]').exists()).toBe(false)
  })
})
