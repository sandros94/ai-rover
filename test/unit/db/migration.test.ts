import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from './helpers'

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.sql'))
    .toSorted()
    .map((path) => readFileSync(join(MIGRATIONS_DIR, path), 'utf8'))
    .join('\n')
}

describe('generated migrations', () => {
  const sql = migrationSql()

  it('create every table', () => {
    for (const table of [
      'user_account',
      'user_identity',
      'mission',
      'stop',
      'round',
      'submission',
      'submission_like',
      'segment',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('carry the composite primary keys', () => {
    expect(sql).toMatch(/PRIMARY KEY\("provider","subject"\)/)
    expect(sql).toMatch(/PRIMARY KEY\("submission_id","user_id"\)/)
  })

  it('carry the partial unique indexes', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "submission_open_per_user_idx" ON "submission" \("round_id","user_id"\) WHERE .*'open'/,
    )
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "round_open_per_mission_idx" ON "round" \("mission_id"\) WHERE .*'open'/,
    )
  })
})
