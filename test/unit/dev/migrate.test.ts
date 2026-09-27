import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDB } from '#server/utils/db'
import {
  databaseRefusal,
  migrateLocalDatabase,
  prepareLocalDatabase,
  RESET_REMEDY,
  resetLocalDatabase,
} from '~~/modules/dev/runtime/server/utils/migrate'
import { copyMigrations, INIT, MIGRATIONS, startLocalDatabase } from './helpers'

let local: Awaited<ReturnType<typeof startLocalDatabase>>
let migrations: Awaited<ReturnType<typeof copyMigrations>>

beforeAll(async () => (local = await startLocalDatabase()))
afterAll(() => local.stop())
beforeEach(async () => {
  await local.reset()
  migrations = await copyMigrations()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await migrations.remove()
})

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await useDB().execute(query)) as { rows: T[] }).rows
}

const initFile = () => join(migrations.dir, INIT, 'migration.sql')

describe('migrateLocalDatabase', () => {
  it('applies the pending migrations once and records their digests', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await migrateLocalDatabase(local.url, migrations.dir)).toBeNull()
    expect(log).toHaveBeenCalledWith(
      `[database] applied ${MIGRATIONS.length} migration(s): ${MIGRATIONS.join(', ')}`,
    )

    const applied = await rows<{ name: string }>(
      sql`select name from netlify.migrations order by name`,
    )
    expect(applied).toEqual(MIGRATIONS.map((name) => ({ name })))
    const digests = await Promise.all(
      MIGRATIONS.map(async (name) => ({
        name,
        digest: createHash('sha256')
          .update(await readFile(join(migrations.dir, name, 'migration.sql')))
          .digest('hex'),
      })),
    )
    expect(
      await rows<{ name: string; digest: string }>(
        sql`select name, digest from rover_dev.migration_digest order by name`,
      ),
    ).toEqual(digests)

    log.mockClear()
    expect(await migrateLocalDatabase(local.url, migrations.dir)).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(await rows(sql`select name from netlify.migrations`)).toHaveLength(MIGRATIONS.length)
  })

  it('refuses when the recorded digest no longer matches the file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await migrateLocalDatabase(local.url, migrations.dir)
    await useDB().execute(sql`update rover_dev.migration_digest set digest = 'tampered'`)

    const refusal = await migrateLocalDatabase(local.url, migrations.dir)
    expect(refusal).toContain(`${INIT} was edited after this database applied it`)
    expect(refusal).toContain(RESET_REMEDY)
  })

  it('refuses when an applied file was edited on disk', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await migrateLocalDatabase(local.url, migrations.dir)
    await appendFile(initFile(), '\n-- edited\n')

    expect(await migrateLocalDatabase(local.url, migrations.dir)).toContain(
      `${INIT} was edited after this database applied it`,
    )
  })

  it('refuses when an applied file was removed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await migrateLocalDatabase(local.url, migrations.dir)
    await rm(join(migrations.dir, INIT), { recursive: true })

    const refusal = await migrateLocalDatabase(local.url, migrations.dir)
    expect(refusal).toContain(`${INIT} was removed after this database applied it`)
    expect(refusal).toContain(RESET_REMEDY)
  })

  it('records a digest for an applied migration it has none for', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await migrateLocalDatabase(local.url, migrations.dir)
    await useDB().execute(sql`delete from rover_dev.migration_digest`)

    expect(await migrateLocalDatabase(local.url, migrations.dir)).toBeNull()
    expect(await rows(sql`select name from rover_dev.migration_digest order by name`)).toEqual(
      MIGRATIONS.map((name) => ({ name })),
    )
  })

  it('turns a failing migration into a refusal', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broken = join(migrations.dir, '29990101000000_broken')
    await mkdir(broken)
    await writeFile(join(broken, 'migration.sql'), 'select nope from nowhere;')

    const refusal = await migrateLocalDatabase(local.url, migrations.dir)
    expect(refusal).toMatch(
      /^The local database could not be brought up to its migrations: .*nowhere/,
    )
    expect(refusal).toContain(RESET_REMEDY)
    expect(await rows(sql`select name from netlify.migrations order by name`)).toEqual(
      MIGRATIONS.map((name) => ({ name })),
    )
  })

  it('leaves a database that is not on this machine untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      await migrateLocalDatabase('postgres://u:secret@db.example.com:5432/neondb', migrations.dir),
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db.example.com:5432'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
    expect(await rows(sql`select name from netlify.migrations order by name`)).toEqual([])
  })
})

describe('prepareLocalDatabase and resetLocalDatabase', () => {
  it('hold the refusal until a reset brings the database back to its migrations', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await prepareLocalDatabase(local.url, migrations.dir)
    expect(await databaseRefusal()).toBeNull()

    await rm(join(migrations.dir, INIT), { recursive: true })
    await prepareLocalDatabase(local.url, migrations.dir)
    expect(await databaseRefusal()).toContain('was removed after this database applied it')

    migrations = await copyMigrations()
    expect(await resetLocalDatabase(local.url, migrations.dir)).toBeNull()
    expect(await databaseRefusal()).toBeNull()
  })

  it('drops every user schema and applies the migrations again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await migrateLocalDatabase(local.url, migrations.dir)
    await useDB().execute(sql`create schema scratch`)
    await useDB().execute(
      sql`insert into user_account (id, display_name) values (gen_random_uuid(), 'Ada')`,
    )

    expect(await resetLocalDatabase(local.url, migrations.dir)).toBeNull()
    expect(await rows(sql`select 1 from user_account`)).toEqual([])
    expect(
      await rows(sql`select 1 from information_schema.schemata where schema_name = 'scratch'`),
    ).toEqual([])
    const names = MIGRATIONS.map((name) => ({ name }))
    expect(await rows(sql`select name from netlify.migrations order by name`)).toEqual(names)
    expect(await rows(sql`select name from rover_dev.migration_digest order by name`)).toEqual(
      names,
    )
  })

  it('refuses to reset a database that is not on this machine', async () => {
    await expect(
      resetLocalDatabase('postgres://db.example.com/neondb', migrations.dir),
    ).rejects.toThrow(/db\.example\.com.*not on this machine/)
  })
})
