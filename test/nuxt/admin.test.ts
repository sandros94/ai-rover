import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { clearError, clearNuxtData, useError, useState } from '#imports'
import type { AccountView } from '#shared/utils/account'
import type { AdminStatus } from '#shared/utils/admin'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import AdminPage from '~/pages/admin.vue'

const ID = '0192f000-0000-7000-8000-00000000000a'
let status: AdminStatus = { admin: true, missionActive: false }
let answer: () => Response = () => new Response(null, { status: 500 })
const bodies: unknown[] = []

registerEndpoint('/api/admin/status', () => status)
registerEndpoint('/api/_auth/account', (): AccountView => ({
  id: ID,
  primaryProvider: 'github',
  identities: [
    {
      provider: 'github',
      subject: '583231',
      displayName: 'Octo',
      avatarUrl: null,
      handle: 'octo',
      linkedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      provider: 'atproto',
      subject: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      displayName: 'Octo',
      avatarUrl: null,
      handle: 'octo.bsky.social',
      linkedAt: '2026-09-02T00:00:00.000Z',
    },
  ],
}))
registerEndpoint('/api/admin/seed', {
  method: 'POST',
  handler: async (event) => {
    bodies.push(await event.req.json())
    return answer()
  },
})

let diagnosis: () => Response = () => new Response(null, { status: 500 })
let diagnosed = 0
registerEndpoint('/api/admin/diagnose', {
  method: 'POST',
  handler: () => {
    diagnosed++
    return diagnosis()
  },
})

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })

function signIn() {
  useState('rover-user-session').value = {
    user: { id: ID, displayName: 'Octo', providers: ['github'] },
    loggedInAt: 1,
  }
}

afterEach(async () => {
  await clearError()
  clearNuxtData()
  useState('rover-user-session').value = {}
  status = { admin: true, missionActive: false }
  bodies.length = 0
  diagnosed = 0
})

async function settle() {
  for (let k = 0; k < 5; k++) await flushPromises()
}

describe('admin page', () => {
  it('does not exist to a visitor signed out: the not-found of an unknown page', async () => {
    status = { admin: false }
    await mountSuspended(AdminPage).catch(() => {})
    await settle()
    expect(useError().value).toMatchObject({ status: 404, statusText: 'Page not found: /' })
  })

  it('shows a signed-in visitor not listed the not-found and their own identity keys', async () => {
    signIn()
    status = { admin: false }
    const wrapper = await mountSuspended(AdminPage)
    await settle()
    expect(wrapper.find('[data-test=admin-not-found]').text()).toContain('Page not found')
    expect(wrapper.findAll('[data-test=admin-keys] code').map((code) => code.text())).toEqual([
      'github:583231',
      'atproto:did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    ])
    expect(wrapper.find('[data-test=admin-diagnose]').exists()).toBe(false)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('offers an admin the landing form while no mission is active, and lands one', async () => {
    signIn()
    answer = () =>
      json(201, { missionId: 'm-1', stopId: 's-1', roundId: 'r-1', worldHash: '0123456789abcdef' })
    const wrapper = await mountSuspended(AdminPage)
    expect(wrapper.find('[data-test=admin-not-found]').exists()).toBe(false)
    expect(wrapper.find<HTMLInputElement>('[data-test=admin-seed] input').element.value).toBe(
      'mars',
    )
    expect(wrapper.find('button[type=submit]').text()).toBe('Land the mission')

    status = { admin: true, missionActive: true }
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(bodies).toEqual([{ seed: 'mars', x: 0, y: 0 }])
    expect(wrapper.find('[data-test=admin-result]').text()).toContain('m-1')
    // A mission is active now: no second landing is offered.
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('shows no landing form while a mission is active', async () => {
    signIn()
    status = { admin: true, missionActive: true }
    const wrapper = await mountSuspended(AdminPage)
    expect(wrapper.find('[data-test=admin-diagnose]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('runs diagnostics for an admin and marks each section', async () => {
    signIn()
    status = { admin: true, missionActive: true }
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
    await wrapper.find('[data-test=admin-diagnose]').trigger('click')
    await settle()

    expect(diagnosed).toBe(1)
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
    expect(wrapper.find('[data-test=diagnosis-blobs]').attributes('data-ok')).toBe('true')
    const runtime = wrapper.find('[data-test=diagnosis-runtime]')
    expect(runtime.attributes('data-ok')).toBe('true')
    expect(runtime.text()).toContain('eu-central-1')
  })

  it('shows the refusal the server answered', async () => {
    signIn()
    answer = () =>
      json(409, { status: 409, message: 'Mission m-0 is active; another lands only once none is.' })
    const wrapper = await mountSuspended(AdminPage)
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(wrapper.find('[data-test=admin-error]').text()).toContain('Mission m-0 is active')
    expect(wrapper.find('[data-test=admin-result]').exists()).toBe(false)
  })
})
