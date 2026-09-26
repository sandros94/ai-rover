import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from '@netlify/database'
import { applyMigrations, NetlifyDB } from '@netlify/database-dev'
import { sql as raw } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/netlify-db'
import { describe, expect, it } from 'vitest'
import { relations } from '#server/database/schema'
import { executorOver } from '~~/modules/dev-db/runtime/server/utils/executor'
import { JUDGMENT, METRICS, MIGRATIONS_DIR, SUMMARY } from './helpers'

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

  it('anchor rounds, allow void rounds and require a reason on every rejection', () => {
    expect(sql).toMatch(/ADD COLUMN "anchor_x" double precision/)
    expect(sql).toMatch(/ADD COLUMN "anchor_y" double precision/)
    expect(sql).toMatch(
      /CONSTRAINT "round_status_check" CHECK \("status" in \('open', 'closed', 'void'\)\)/,
    )
    expect(sql).toMatch(/ADD COLUMN "rejection_reason" text/)
    expect(sql).toMatch(/CONSTRAINT "submission_rejection_check"/)
  })
})

describe('the round_anchor migration', () => {
  it('applies after init and backfills anchors and rejection reasons on existing rows', async () => {
    const server = new NetlifyDB({ logger: () => {} })
    const connection = getDatabase({ connectionString: await server.start() })
    const db = drizzle({ client: connection, relations })
    try {
      const [init, ...later] = readdirSync(MIGRATIONS_DIR).toSorted()
      expect(init).toMatch(/_init$/)
      expect(later.some((name) => name.endsWith('_round_anchor'))).toBe(true)
      expect(await applyMigrations(executorOver(db), MIGRATIONS_DIR, init)).toEqual([init])

      const json = (value: unknown) => JSON.stringify(value)
      await db.execute(raw`
        insert into user_account (id, display_name) values ('01900000-0000-7000-8000-000000000001', 'Ada');
        insert into mission (id, seed, world_hash, config) values ('01900000-0000-7000-8000-000000000002', 'mars', '0123456789abcdef', '{}');
        insert into stop (id, mission_id, index, x, y, heading_rad, manifest_key, revealed_key)
          values ('01900000-0000-7000-8000-000000000003', '01900000-0000-7000-8000-000000000002', 0, 12.5, -4, 0, 'm', 'r');
        insert into round (id, mission_id, from_stop_id) values ('01900000-0000-7000-8000-000000000004', '01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000000003');
      `)
      for (const [id, status] of [
        ['01900000-0000-7000-8000-000000000005', 'rejected'],
        ['01900000-0000-7000-8000-000000000006', 'open'],
      ]) {
        await db.execute(raw`
          insert into submission (id, round_id, user_id, goal_x, goal_y, status, judgment, metrics, summary)
          values (${id}, '01900000-0000-7000-8000-000000000004', '01900000-0000-7000-8000-000000000001', 0, 80, ${status},
            ${json(JUDGMENT)}, ${json(METRICS)}, ${json(SUMMARY)})`)
      }

      expect(await applyMigrations(executorOver(db), MIGRATIONS_DIR)).toEqual(later)
      const rounds = await db.execute(raw`select anchor_x, anchor_y from round`)
      expect(rounds.rows).toEqual([{ anchor_x: 12.5, anchor_y: -4 }])
      const submissions = await db.execute(
        raw`select status, rejection_reason from submission order by id`,
      )
      expect(submissions.rows).toEqual([
        { status: 'rejected', rejection_reason: 'judged-infeasible' },
        { status: 'open', rejection_reason: null },
      ])
    } finally {
      await connection.pool.end()
      await server.stop()
    }
  })
})
