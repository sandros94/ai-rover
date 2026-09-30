import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useNuxtApp } from '#imports'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import App from '~/app.vue'

const publicFile = (href: string) => join(process.cwd(), 'public', href)

describe('the icons in the head', () => {
  it('links the SVG icon, its PNG fallback, the touch icon and the manifest, all served', async () => {
    const wrapper = await mountSuspended(App)
    await flushPromises()
    // What the page puts in its head; the client writes it to the DOM on its own schedule.
    const head = useNuxtApp().vueApp._context.provides.usehead as {
      entries: Map<unknown, { input: { link?: Record<string, string>[] } }>
    }
    const links = [...head.entries.values()]
      .flatMap((entry) => entry.input.link ?? [])
      .map(({ rel, href, type }) => ({ rel, href: href!, type: type ?? null }))
    expect(links).toEqual(
      expect.arrayContaining([
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'icon', href: '/favicon-32.png', type: 'image/png' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', type: null },
        { rel: 'manifest', href: '/site.webmanifest', type: null },
      ]),
    )
    for (const { href } of links.filter((link) => link.href.startsWith('/'))) {
      expect(existsSync(publicFile(href))).toBe(true)
    }
    wrapper.unmount()
  })

  it('names the product in the manifest, with a maskable icon among files that exist', () => {
    const manifest = JSON.parse(readFileSync(publicFile('/site.webmanifest'), 'utf8')) as {
      name: string
      icons: { src: string; purpose: string }[]
    }
    expect(manifest.name).toBe('AI Rover')
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    for (const { src } of manifest.icons) expect(existsSync(publicFile(src))).toBe(true)
  })
})
