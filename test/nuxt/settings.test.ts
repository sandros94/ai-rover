import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { clearNuxtData, clearNuxtState, useState } from '#imports'
import { USelect } from '#components'
import type { AccountView } from '#shared/utils/account'
import { SCENE_QUALITY_KEY } from '~/composables/useSceneQuality'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SettingsPage from '~/pages/settings.vue'

const ID = '0192f000-0000-7000-8000-00000000000a'
const identity = (provider: 'github' | 'discord', displayName: string) => ({
  provider,
  displayName,
  avatarUrl: null,
  handle: displayName.toLowerCase(),
  linkedAt: '2026-09-01T00:00:00.000Z',
})

let account: AccountView
const patched: unknown[] = []
const deleted: string[] = []

registerEndpoint('/api/_auth/session', () => ({
  user: { id: ID, displayName: 'Octo', providers: ['github'] },
  loggedInAt: 1,
}))
registerEndpoint('/api/auth/providers', () => ({ providers: ['github', 'discord', 'atproto'] }))
registerEndpoint('/api/_auth/account', { method: 'GET', handler: () => account })
registerEndpoint('/api/_auth/account', {
  method: 'PATCH',
  handler: async (event) => {
    const body = (await event.req.json()) as { primaryProvider: 'github' | 'discord' }
    patched.push(body)
    return { ...account, primaryProvider: body.primaryProvider }
  },
})
registerEndpoint('/api/_auth/identities/discord', {
  method: 'DELETE',
  handler: () => {
    deleted.push('discord')
    return { ...account, identities: account.identities.filter((i) => i.provider !== 'discord') }
  },
})

function signIn() {
  useState('rover-user-session').value = {
    user: { id: ID, displayName: 'Octo', providers: ['github'] },
    loggedInAt: 1,
  }
}

afterEach(() => {
  clearNuxtData()
  useState('rover-user-session').value = {}
  useState('rover-auth-providers').value = null
  patched.length = 0
  deleted.length = 0
  localStorage.removeItem(SCENE_QUALITY_KEY)
  clearNuxtState(['scene-quality', 'scene-quality-read'])
})

describe('settings page', () => {
  it('offers to link the missing platforms and keeps the last one from being unlinked', async () => {
    account = { id: ID, primaryProvider: 'github', identities: [identity('github', 'Octo')] }
    signIn()
    const wrapper = await mountSuspended(SettingsPage, { route: '/settings' })
    const github = wrapper.find('[data-test=platform-github]')
    expect(github.find('[data-test=unlink]').attributes('disabled')).toBeDefined()
    const discord = wrapper.find('[data-test=platform-discord] [data-test=link]')
    expect(discord.attributes('href')).toBe('/api/auth/discord?redirect=%2Fsettings&link=')
    expect(wrapper.find('[data-test=platform-atproto] [data-test=link-atproto]').exists()).toBe(
      true,
    )
    // One identity leaves nothing to choose.
    expect(wrapper.find('[data-test=primary]').exists()).toBe(false)
  })

  it('unlinks any identity but the last', async () => {
    account = {
      id: ID,
      primaryProvider: 'github',
      identities: [identity('github', 'Octo'), identity('discord', 'Nelly')],
    }
    signIn()
    const wrapper = await mountSuspended(SettingsPage, { route: '/settings' })
    const unlink = wrapper.find('[data-test=platform-discord] [data-test=unlink]')
    expect(unlink.attributes('disabled')).toBeUndefined()
    await unlink.trigger('click')
    await flushPromises()
    expect(deleted).toEqual(['discord'])
    expect(
      wrapper.find('[data-test=platform-github] [data-test=unlink]').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.find('[data-test=platform-discord] [data-test=link]').exists()).toBe(true)
  })

  it('switches the identity that supplies the name and avatar', async () => {
    account = {
      id: ID,
      primaryProvider: 'github',
      identities: [identity('github', 'Octo'), identity('discord', 'Nelly')],
    }
    signIn()
    const wrapper = await mountSuspended(SettingsPage, { route: '/settings' })
    const radios = wrapper.findAll('[data-test=primary] [role=radio]')
    expect(radios).toHaveLength(2)
    expect(radios[0]!.attributes('aria-checked')).toBe('true')
    await radios[1]!.trigger('click')
    await flushPromises()
    expect(patched).toEqual([{ primaryProvider: 'discord' }])
    expect(wrapper.findAll('[data-test=primary] [role=radio]')[1]!.attributes('aria-checked')).toBe(
      'true',
    )
  })

  it('says why a link came back refused', async () => {
    account = { id: ID, primaryProvider: 'github', identities: [identity('github', 'Octo')] }
    signIn()
    const wrapper = await mountSuspended(SettingsPage, {
      route: '/settings?error=link-conflict',
    })
    expect(wrapper.find('[data-test=link-error]').text()).toContain('same platform')
  })
})

describe('graphics settings', () => {
  type Page = Awaited<ReturnType<typeof mountSuspended>>
  const select = (wrapper: Page, test: string) =>
    wrapper
      .findAllComponents(USelect)
      .find((found: VueWrapper) => found.vm.$attrs['data-test'] === test)!

  it('is open to visitors, with the graphics alone', async () => {
    const wrapper = await mountSuspended(SettingsPage, { route: '/settings' })
    expect(wrapper.find('[data-test=graphics]').exists()).toBe(true)
    expect(wrapper.find('[data-test=platform-github]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Linked platforms')
  })

  it('shows what the tier sets and stores the tier and the knobs chosen over it', async () => {
    const wrapper = await mountSuspended(SettingsPage, { route: '/settings' })
    select(wrapper, 'graphics-tier').vm.$emit('update:modelValue', 'low')
    await flushPromises()
    const sets = wrapper.find('[data-test=graphics-tier-sets]').text()
    expect(sets).toContain('60 fps')
    expect(sets).toContain('1×')
    expect(sets).toContain('Rover only')
    expect(sets).toContain('20 m')

    select(wrapper, 'graphics-shadows').vm.$emit('update:modelValue', 'off')
    select(wrapper, 'graphics-frame-cap').vm.$emit('update:modelValue', 'display')
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(SCENE_QUALITY_KEY)!)).toEqual({
      tier: 'low',
      shadows: 'off',
      frameCap: 'display',
    })
    expect(useSceneQuality().quality.value).toMatchObject({ shadows: 'off', frameCap: Infinity })

    select(wrapper, 'graphics-shadows').vm.$emit('update:modelValue', 'tier')
    await flushPromises()
    expect(useSceneQuality().choice.value).toEqual({ tier: 'low', frameCap: 'display' })
  })
})
