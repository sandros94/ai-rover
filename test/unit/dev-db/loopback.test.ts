import { describe, expect, it } from 'vitest'
import { databaseHost, isLoopback } from '~~/modules/dev-db/runtime/server/utils/loopback'

describe('isLoopback', () => {
  it.each([
    'postgres://postgres@localhost:5432/postgres',
    'postgres://postgres@127.0.0.1:61234/postgres',
    'postgres://postgres@[::1]:5432/postgres',
    'postgresql://localhost/postgres',
  ])('accepts %s', (url) => {
    expect(isLoopback(url)).toBe(true)
  })

  it.each([
    undefined,
    '',
    'not a url',
    'postgres://user:secret@ep-cool-name.eu-central-1.aws.neon.tech/neondb',
    'postgres://localhost.example.com/postgres',
    'postgres://127.0.0.2/postgres',
    'postgres://0.0.0.0/postgres',
  ])('refuses %s', (url) => {
    expect(isLoopback(url)).toBe(false)
  })
})

describe('databaseHost', () => {
  it('names the host and port, never the credentials or database', () => {
    expect(databaseHost('postgres://user:secret@db.example.com:5432/neondb')).toBe(
      'db.example.com:5432',
    )
  })

  it('says when there is nothing to name', () => {
    expect(databaseHost(undefined)).toBe('(unset)')
    expect(databaseHost('not a url')).toBe('(unparseable)')
  })
})
