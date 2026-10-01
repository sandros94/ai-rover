/**
 * Renders the social cards: `public/og.jpg` (1200×630, the page's `og:image`) and
 * `.github/social-preview.jpg` (1280×640, uploaded by hand under the repository's settings,
 * never deployed). Each is the staged still from the dev page `/_dev/og`, captured in headless
 * Chromium, with the name, the tagline and the address composited over it by Takumi in the
 * app's font. Re-running overwrites both; the 3D still is not bit-for-bit repeatable across
 * machines, the type is.
 *
 * Needs `pnpm dev` running. Run from the repository root; arguments are passed to the page as
 * its query (see the page for the keys), `OG_BASE_URL` points at another dev server:
 *
 *   pnpm dlx jiti@2 scripts/og-image.ts
 *   pnpm dlx jiti@2 scripts/og-image.ts yaw=20 back=8
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { render } from 'takumi-js'
import { Renderer } from 'takumi-js/node'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_URL = process.env.OG_BASE_URL ?? 'http://localhost:3000'
/** The scene's own quality setting, as the settings page stores it. */
const QUALITY_KEY = 'ai-rover:scene-quality'
/**
 * Captured wider than either card, at twice the pixels for clean edges: the rover stands in the
 * middle of the still, and each card shifts it right of the type, to {@link ROVER_AT}.
 */
const STILL = { width: 1920, height: 672, scale: 2 }
/** Where across a card the rover stands, as a share of its width. */
const ROVER_AT = 0.68
const READY_TIMEOUT_MS = 180_000
/** The wheel mark's colour on dark ground, as the icon's dark scheme draws it. */
const WHEEL = '#fb923c'
const JPEG_QUALITY = 86

const TITLE = 'AI Rover'
const TAGLINE = 'A community-steered autonomous rover on procedurally generated Martian terrain.'
const DETAIL = 'Steered by votes · judged by TypeSafe Jev · built with Nuxt, Nuxt UI and TresJS'
const ADDRESS = 'rover.s94.dev'

const CARDS = [
  { file: 'public/og.jpg', width: 1200, height: 630 },
  { file: '.github/social-preview.jpg', width: 1280, height: 640 },
]

async function captureStill(): Promise<Buffer> {
  const query = new URLSearchParams(
    process.argv.slice(2).map((arg) => arg.split('=', 2) as [string, string]),
  )
  const url = `${BASE_URL}/_dev/og?${query}`
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: STILL.width, height: STILL.height },
      deviceScaleFactor: STILL.scale,
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.addInitScript((key) => localStorage.setItem(key, 'high'), QUALITY_KEY)
    await page.goto(url)
    // The page's own chrome and the dev tools' dock stay out of the still.
    await page.addStyleTag({
      content:
        '[data-site-credits], devframes-dock-embedded, nuxt-devtools-inspect-panel, #vue-tracer-overlay { display: none !important; }',
    })
    await page
      .waitForSelector('html[data-og-ready]', { state: 'attached', timeout: READY_TIMEOUT_MS })
      .catch((cause: unknown) => {
        throw new Error(`${url} never got ready${errors.length ? `: ${errors.join('; ')}` : ''}`, {
          cause,
        })
      })
    return await page.screenshot({ type: 'png' })
  } finally {
    await browser.close()
  }
}

const font = (weight: number) =>
  readFileSync(
    join(
      ROOT,
      `node_modules/@fontsource/public-sans/files/public-sans-latin-${weight}-normal.woff2`,
    ),
  )

/** The detailed wheel mark in one colour, rasterised: its SVG picks a colour by colour scheme. */
async function wheelMark(size: number): Promise<string> {
  const svg = readFileSync(join(ROOT, 'public/icon.svg'), 'utf8')
    .replace(/@media[^}]*}\s*}/, '')
    .replace(/color: #[0-9a-f]{6}/, `color: ${WHEEL}`)
  const png = await sharp(Buffer.from(svg), { density: (72 * size) / 32 })
    .resize(size, size)
    .png()
    .toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

function card(still: string, wheel: string, width: number, height: number): string {
  // The still at the card's height, its middle (the rover) moved to `ROVER_AT`.
  const stillWidth = Math.round((height * STILL.width) / STILL.height)
  const left = Math.round(width * ROVER_AT - stillWidth / 2)
  return `
<div style="display: flex; width: 100%; height: 100%; position: relative; font-family: 'Public Sans'; color: #fafafa; background: #171717;">
  <img src="${still}" style="position: absolute; top: 0; left: ${left}px; width: ${stillWidth}px; height: ${height}px;" />
  <div style="position: absolute; inset: 0; background-image: linear-gradient(90deg, rgba(10,10,10,0.82) 0%, rgba(10,10,10,0.55) 38%, rgba(10,10,10,0) 66%);"></div>
  <div style="position: absolute; inset: 0; background-image: linear-gradient(0deg, rgba(10,10,10,0.6) 0%, rgba(10,10,10,0) 30%);"></div>
  <div style="position: relative; display: flex; flex-direction: column; justify-content: space-between; width: 100%; height: 100%; padding: 64px 72px;">
    <div style="display: flex; flex-direction: column; gap: 22px; max-width: 600px;">
      <div style="display: flex; align-items: center; gap: 20px;">
        <img src="${wheel}" style="width: 72px; height: 72px;" />
        <span style="font-size: 84px; font-weight: 700; letter-spacing: -2px; line-height: 1;">${TITLE}</span>
      </div>
      <span style="font-size: 34px; font-weight: 600; line-height: 1.25; color: #f5f5f5;">${TAGLINE}</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 10px; max-width: 640px;">
      <span style="font-size: 22px; font-weight: 400; line-height: 1.35; color: #d4d4d4;">${DETAIL}</span>
      <span style="font-size: 26px; font-weight: 600; color: ${WHEEL};">${ADDRESS}</span>
    </div>
  </div>
</div>`
}

const renderer = new Renderer()
for (const weight of [400, 600, 700]) {
  await renderer.registerFont({ name: 'Public Sans', data: font(weight), weight })
}

const still = `data:image/png;base64,${(await captureStill()).toString('base64')}`
const wheel = await wheelMark(144)
for (const { file, width, height } of CARDS) {
  const png = await render(card(still, wheel, width, height), {
    renderer,
    width,
    height,
    format: 'png',
  })
  const jpeg = await sharp(png).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
  writeFileSync(join(ROOT, file), jpeg)
  console.log(`og-image: wrote ${file} (${width}×${height}, ${Math.round(jpeg.length / 1024)} KiB)`)
}
