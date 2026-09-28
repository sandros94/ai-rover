import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import SiteCredits from '~/components/SiteCredits.vue'

describe('SiteCredits', () => {
  it('links the source on GitHub and the Netlify badge, each in a new tab', async () => {
    const wrapper = await mountSuspended(SiteCredits)
    const source = wrapper.find('[data-test=credit-source]')
    expect(source.attributes('href')).toBe('https://github.com/sandros94/ai-rover')
    expect(source.attributes('aria-label')).toBe('Source on GitHub')
    const host = wrapper.find('[data-test=credit-host]')
    expect(host.attributes('href')).toBe('https://www.netlify.com')
    expect(host.find('img').attributes('alt')).toBe('Deploys by Netlify')
    expect(host.find('img').attributes('src')).toBe(
      'https://www.netlify.com/img/global/badges/netlify-color-accent.svg',
    )
    for (const link of [source, host]) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noopener')
    }
  })
})
