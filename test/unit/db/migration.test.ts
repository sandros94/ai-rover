import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from '@netlify/database'
import { applyMigrations, NetlifyDB } from '@netlify/database-dev'
import { sql as raw } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/netlify-db'
import { describe, expect, it } from 'vitest'
import { relations } from '#server/database/schema'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { executorOver } from '~~/modules/dev/runtime/server/utils/executor'
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

describe('the due_and_jev_cache migration', () => {
  it('makes existing active missions due and gives their rules the attempt cap', async () => {
    const server = new NetlifyDB({ logger: () => {} })
    const connection = getDatabase({ connectionString: await server.start() })
    const db = drizzle({ client: connection, relations })
    try {
      const names = readdirSync(MIGRATIONS_DIR).toSorted()
      const at = names.findIndex((name) => name.endsWith('_due_and_jev_cache'))
      expect(at).toBeGreaterThan(0)
      await applyMigrations(executorOver(db), MIGRATIONS_DIR, names[at - 1])

      const { maxJudgedPerRound: _cap, ...older } = DEFAULT_MISSION_RULES
      const config = JSON.stringify({ world: {}, rules: older })
      const capped = JSON.stringify({ world: {}, rules: { ...older, maxJudgedPerRound: 2 } })
      await db.execute(raw`
        insert into mission (id, seed, world_hash, config, status) values
          ('01900000-0000-7000-8000-000000000001', 'mars', '0123456789abcdef', ${config}, 'active'),
          ('01900000-0000-7000-8000-000000000002', 'mars', '0123456789abcdef', ${config}, 'ended'),
          ('01900000-0000-7000-8000-000000000003', 'mars', '0123456789abcdef', ${capped}, 'ended')`)

      expect(await applyMigrations(executorOver(db), MIGRATIONS_DIR)).toEqual(names.slice(at))
      const missions = await db.execute<{ due: boolean; cap: number }>(raw`
        select next_due_at is not null as due, (config -> 'rules' -> 'maxJudgedPerRound')::int as cap
        from mission order by id`)
      expect(missions.rows).toEqual([
        { due: true, cap: 5 },
        { due: false, cap: 5 },
        { due: false, cap: 2 },
      ])
    } finally {
      await connection.pool.end()
      await server.stop()
    }
  })
})

describe('the ai_judgment migration', () => {
  it('renames the judgment cache in place, keeping its rows and primary key', async () => {
    const server = new NetlifyDB({ logger: () => {} })
    const connection = getDatabase({ connectionString: await server.start() })
    const db = drizzle({ client: connection, relations })
    try {
      const names = readdirSync(MIGRATIONS_DIR).toSorted()
      const at = names.findIndex((name) => name.endsWith('_ai_judgment'))
      expect(at).toBeGreaterThan(0)
      await applyMigrations(executorOver(db), MIGRATIONS_DIR, names[at - 1])
      await db.execute(raw`
        insert into jev_judgment (hash, model, answers) values ('h1', 'm', '{"verdict":"accept"}')`)

      expect(await applyMigrations(executorOver(db), MIGRATIONS_DIR)).toEqual(names.slice(at))
      const rows = await db.execute(raw`select hash, model, answers from ai_judgment`)
      expect(rows.rows).toEqual([{ hash: 'h1', model: 'm', answers: { verdict: 'accept' } }])
      const keys = await db.execute(raw`
        select conname from pg_constraint where conrelid = 'ai_judgment'::regclass and contype = 'p'`)
      expect(keys.rows).toEqual([{ conname: 'ai_judgment_pkey' }])
      const old = await db.execute(raw`select to_regclass('jev_judgment') is null as gone`)
      expect(old.rows).toEqual([{ gone: true }])
    } finally {
      await connection.pool.end()
      await server.stop()
    }
  })
})

describe('the stop_radius_rule migration', () => {
  it('gives the rules of existing missions the stop radius their stops were published with', async () => {
    const server = new NetlifyDB({ logger: () => {} })
    const connection = getDatabase({ connectionString: await server.start() })
    const db = drizzle({ client: connection, relations })
    try {
      const names = readdirSync(MIGRATIONS_DIR).toSorted()
      const at = names.findIndex((name) => name.endsWith('_stop_radius_rule'))
      expect(at).toBeGreaterThan(0)
      await applyMigrations(executorOver(db), MIGRATIONS_DIR, names[at - 1])

      const { stopRadiusM: _radius, ...older } = DEFAULT_MISSION_RULES
      const config = JSON.stringify({ world: {}, rules: older })
      const small = JSON.stringify({ world: {}, rules: { ...older, stopRadiusM: 120 } })
      await db.execute(raw`
        insert into mission (id, seed, world_hash, config) values
          ('01900000-0000-7000-8000-000000000001', 'mars', '0123456789abcdef', ${config}),
          ('01900000-0000-7000-8000-000000000002', 'mars', '0123456789abcdef', ${small})`)

      expect(await applyMigrations(executorOver(db), MIGRATIONS_DIR)).toEqual(names.slice(at))
      const missions = await db.execute<{ radius: number }>(raw`
        select (config -> 'rules' -> 'stopRadiusM')::int as radius from mission order by id`)
      expect(missions.rows).toEqual([{ radius: 500 }, { radius: 120 }])
    } finally {
      await connection.pool.end()
      await server.stop()
    }
  })
})
