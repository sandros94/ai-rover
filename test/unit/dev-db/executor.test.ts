import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { DB } from '#server/database/db'
import { executorOver, rebindPlaceholders } from '~~/modules/dev-db/runtime/server/utils/executor'
import { createTestDb } from '../db/helpers'

describe('rebindPlaceholders', () => {
  const dialect = new PgDialect()

  it("renumbers the applier's $n in Drizzle's own order, repeating reused values", () => {
    const query = dialect.sqlToQuery(
      rebindPlaceholders('select $2 as b, $1 as a, $2 as c from t where x = $1', ['x', 'y']),
    )
    expect(query.sql).toBe('select $1 as b, $2 as a, $3 as c from t where x = $4')
    expect(query.params).toEqual(['y', 'x', 'y', 'x'])
  })

  it('passes an array as one parameter', () => {
    const query = dialect.sqlToQuery(
      rebindPlaceholders('select name from m where name = any($1)', [['a', 'b']]),
    )
    expect(query.sql).toBe('select name from m where name = any($1)')
    expect(query.params).toEqual([['a', 'b']])
  })

  it('leaves text without placeholders alone', () => {
    const query = dialect.sqlToQuery(rebindPlaceholders('select 1', []))
    expect(query).toMatchObject({ sql: 'select 1', params: [] })
  })

  it('refuses a placeholder with no parameter', () => {
    expect(() => rebindPlaceholders('select $2', ['only one'])).toThrow(/\$2.*1 parameter/)
  })
})

describe('executorOver', () => {
  let db: DB
  let close: () => Promise<void>
  beforeAll(async () => ({ db, close } = await createTestDb()))
  afterAll(() => close())

  it('runs a whole multi-statement file in one exec', async () => {
    const executor = executorOver(db)
    await executor.exec(`
      create table exec_probe (n int);
      insert into exec_probe values (1);
      insert into exec_probe values (2);
    `)
    const { rows } = await executor.query<{ total: number }>(
      'select sum(n)::int as total from exec_probe',
    )
    expect(rows).toEqual([{ total: 3 }])
  })

  it('binds parameters in the order the query numbers them', async () => {
    const { rows } = await executorOver(db).query<{ a: string; b: string; c: string }>(
      'select $2::text as b, $1::text as a, $2::text as c',
      ['x', 'y'],
    )
    expect(rows).toEqual([{ b: 'y', a: 'x', c: 'y' }])
  })

  it('commits a transaction that resolves', async () => {
    const executor = executorOver(db)
    await executor.exec('create table tx_commit (name text)')
    const out = await executor.transaction(async (tx) => {
      await tx.exec('insert into tx_commit values ($$a$$)')
      await tx.query('insert into tx_commit values ($1)', ['b'])
      return 'done'
    })
    expect(out).toBe('done')
    const { rows } = await executor.query('select name from tx_commit order by name')
    expect(rows).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('rolls back a transaction that throws', async () => {
    const executor = executorOver(db)
    await executor.exec('create table tx_rollback (name text)')
    await expect(
      executor.transaction(async (tx) => {
        await tx.query('insert into tx_rollback values ($1)', ['lost'])
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    const { rows } = await executor.query('select name from tx_rollback')
    expect(rows).toEqual([])
  })
})
