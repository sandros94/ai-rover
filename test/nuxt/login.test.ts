import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { SIGN_IN_ERRORS, UNKNOWN_SIGN_IN_ERROR } from '#shared/utils/sign-in'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import LoginPage from '~/pages/login.vue'

registerEndpoint('/api/_auth/session', () => ({}))
registerEndpoint('/api/auth/providers', () => ({ providers: ['atproto'] }))

describe('login page', () => {
  it('shows no error without an error code', async () => {
    const wrapper = await mountSuspended(LoginPage, { route: '/login' })
    expect(wrapper.find('[data-test=login-error]').exists()).toBe(false)
  })

  it('says what a known error code means', async () => {
    const wrapper = await mountSuspended(LoginPage, { route: '/login?error=sign-in-failed' })
    const error = wrapper.find('[data-test=login-error]')
    expect(error.text()).toContain(SIGN_IN_ERRORS['sign-in-failed'])
    expect(error.text()).not.toContain('[object')
  })

  it('says a generic sentence for an unknown code, never the code itself', async () => {
    for (const code of ['boom', '<b>x</b>', 'constructor']) {
      const wrapper = await mountSuspended(LoginPage, {
        route: `/login?${new URLSearchParams({ error: code })}`,
      })
      const text = wrapper.find('[data-test=login-error]').text()
      expect(text).toContain(UNKNOWN_SIGN_IN_ERROR)
      expect(text).not.toContain(code)
    }
  })

  it('names the protocol, not one of its apps, for handle sign-in', async () => {
    const wrapper = await mountSuspended(LoginPage, { route: '/login' })
    const form = wrapper.find('[data-test=atproto-sign-in]')
    expect(form.text()).toContain('Continue with AT Protocol')
    expect(form.find('input').attributes('aria-label')).toBe('AT Protocol handle or DID')
    expect(wrapper.text()).not.toContain('Bluesky')
  })
})
