import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useRouter, useState } from '#imports'
import { UApp } from '#components'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import UserMenu from '~/components/UserMenu.vue'

const ID = '0192f000-0000-7000-8000-00000000000a'
let signedOut = 0
registerEndpoint('/api/_auth/session', {
  method: 'DELETE',
  handler: () => {
    signedOut++
    return { loggedOut: true }
  },
})

const mounted: { unmount(): void }[] = []

async function mount() {
  const wrapper = await mountSuspended(
    defineComponent({ render: () => h(UApp, null, { default: () => h(UserMenu) }) }),
    { attachTo: document.body },
  )
  mounted.push(wrapper)
  return wrapper
}

async function open(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.find('[data-test=user-menu]').trigger('keydown', { key: 'Enter' })
  await flushPromises()
  return [...document.querySelectorAll<HTMLElement>('[role=menuitem]')]
}

afterEach(() => {
  useState('rover-user-session').value = {}
  signedOut = 0
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('user menu', () => {
  it('keeps the sign-in button for visitors', async () => {
    const wrapper = await mount()
    expect(wrapper.find('[data-test=user-menu]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(true)
    expect(wrapper.find('[data-test=visitor-settings]').attributes('href')).toBe('/settings')
  })

  it('opens on the avatar with the profile, settings and sign-out', async () => {
    useState('rover-user-session').value = {
      user: { id: ID, displayName: 'Ada', providers: ['github'] },
      loggedInAt: 1,
    }
    const wrapper = await mount()
    expect(wrapper.find('[data-test=user-menu]').text()).toContain('Ada')
    const items = await open(wrapper)
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Profile',
      'Settings',
      'Sign out',
    ])
    expect(items[0]!.getAttribute('href')).toBe(`/u/${ID}`)
    expect(items[1]!.getAttribute('href')).toBe('/settings')
  })

  it('signs out and goes home', async () => {
    useState('rover-user-session').value = {
      user: { id: ID, displayName: 'Ada', providers: ['github'] },
      loggedInAt: 1,
    }
    await useRouter().push('/settings')
    const wrapper = await mount()
    const items = await open(wrapper)
    items[2]!.click()
    await flushPromises()
    expect(signedOut).toBe(1)
    expect(useState('rover-user-session').value).toEqual({})
    expect(useRouter().currentRoute.value.path).toBe('/')
  })
})
