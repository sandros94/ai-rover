import { describe, expect, it } from 'vitest'
import { setup } from '@nuxt/test-utils/e2e'

const PORT = 3197
const LISTED = `http://127.0.0.1:${PORT}`
const UNLISTED = `http://localhost:${PORT}`

// A hard load of /login renders on the server, whose own data fetches run in-process from an
// internal address; the providers must follow the address the visitor used instead.
describe('e2e: the login page rendered on the server', async () => {
  await setup({
    port: PORT,
    env: {
      NUXT_SESSION_KEY: 'e2e-login-test-secret-of-at-least-32-characters',
      NUXT_OAUTH_ORIGINS: LISTED,
      NUXT_OAUTH_GITHUB_CLIENT_ID: 'e2e',
      NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'e2e',
    },
  })

  const render = async (origin: string) => (await fetch(`${origin}/login`)).text()

  it('offers the providers on a listed origin', async () => {
    const html = await render(LISTED)
    expect(html).toContain('Continue with GitHub')
    expect(html).toContain('data-test="atproto-sign-in"')
    expect(html).not.toContain('data-test="no-sign-in"')
  })

  it('says sign-in is not available on an unlisted origin', async () => {
    const html = await render(UNLISTED)
    expect(html).toContain('data-test="no-sign-in"')
    expect(html).not.toContain('Continue with GitHub')
  })
})
