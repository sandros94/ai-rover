/**
 * Renders the PNG icons under `public/` from `public/favicon.svg`: a 32 px favicon for browsers
 * without SVG favicons, transparent 192 and 512 px icons for the web manifest, and on the site's
 * dark background a 180 px Apple touch icon (iOS fills transparency with black) and a 512 px
 * maskable icon, the wheel inside the central 80 % circle a mask may keep. The rasteriser ignores
 * the SVG's colour-scheme rule, so the PNGs take the light scheme's orange, and the dark one on
 * the dark background. Deterministic; re-running overwrites them.
 *
 * Run from the repository root:
 *
 *   pnpm dlx jiti@2 scripts/favicon.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '../public')
/** The web manifest's `background_color`: Nuxt UI's neutral 900. */
const BACKGROUND = '#171717'
const LIGHT = '#ea580c'
const DARK = '#fb923c'
/** A maskable icon's safe zone is the central circle of 80 % the icon's width. */
const MASKABLE_SAFE = 0.8

const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8')
if (!svg.includes(`color: ${LIGHT}`) || !svg.includes(`color: ${DARK}`)) {
  throw new Error(`favicon.svg no longer sets ${LIGHT} and ${DARK}; update this script with it.`)
}
/** The SVG in one colour, its colour-scheme rule dropped. */
const inColour = (colour: string) =>
  Buffer.from(svg.replace(/@media[^}]*}\s*}/, '').replace(`color: ${LIGHT}`, `color: ${colour}`))

async function transparent(size: number, file: string): Promise<void> {
  await sharp(inColour(LIGHT), { density: (72 * size) / 32 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(PUBLIC, file))
}

/** The wheel at `share` of the icon's width, centred on the dark background. */
async function onBackground(size: number, share: number, file: string): Promise<void> {
  const inner = Math.round(size * share)
  const wheel = await sharp(inColour(DARK), { density: (72 * inner) / 32 })
    .resize(inner, inner)
    .png()
    .toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: wheel, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(join(PUBLIC, file))
}

await transparent(32, 'favicon-32.png')
await transparent(192, 'icon-192.png')
await transparent(512, 'icon-512.png')
await onBackground(180, 0.8, 'apple-touch-icon.png')
// The wheel's circle spans the square it is drawn in: its diameter is the safe zone's.
await onBackground(512, MASKABLE_SAFE * 0.92, 'icon-maskable-512.png')
console.log('favicon: wrote favicon-32, icon-192, icon-512, apple-touch-icon, icon-maskable-512')
