/**
 * Writes the recorded journey of `journey-fixture.ts` to `test/fixtures/records/`, one file per
 * journey key, uncompressed; replaces whatever was there. Deterministic.
 *
 * Run from the repository root:
 *
 *   JITI_ALIAS="{\"#shared\":\"$PWD/shared\",\"#server\":\"$PWD/server\"}" pnpm exec jiti scripts/record-journey-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJourneyFixture } from './journey-fixture'

const RECORDS_DIR = fileURLToPath(new URL('../test/fixtures/records/', import.meta.url))

const { files } = buildJourneyFixture()
// The README is the only file here not generated.
for (const top of ['terrain', 'missions', 'segments']) {
  rmSync(join(RECORDS_DIR, top), { recursive: true, force: true })
}
const totals = new Map<string, number>()
for (const [key, bytes] of files) {
  const path = join(RECORDS_DIR, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  const kind = key.startsWith('terrain/')
    ? 'chunks'
    : key.startsWith('missions/')
      ? 'stop'
      : 'segment'
  totals.set(kind, (totals.get(kind) ?? 0) + bytes.byteLength)
}
let sum = 0
for (const [kind, bytes] of totals) {
  console.log(`${kind.padEnd(8)} ${bytes.toLocaleString('en')} bytes`)
  sum += bytes
}
console.log(`total    ${sum.toLocaleString('en')} bytes in ${files.size} files`)
