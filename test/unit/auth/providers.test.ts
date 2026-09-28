import { describe, expect, it } from 'vitest'
import { originPolicy } from '~~/modules/auth/runtime/server/lib/origins'
import { providersFor } from '~~/modules/auth/runtime/server/lib/providers'

const github = { clientId: 'id', clientSecret: 'secret' }
const listed = originPolicy('https://rover.example,http://192.168.1.20:3000', false)

describe('providersFor', () => {
  it('offers nothing on an origin sign-in may not redirect to', () => {
    expect(providersFor('https://elsewhere.example', { origins: listed, github })).toEqual([])
    expect(providersFor('http://localhost', { origins: listed, github })).toEqual([])
  })

  it('offers GitHub once its app is configured, and AT Protocol on HTTPS', () => {
    expect(providersFor('https://rover.example', { origins: listed, github })).toEqual([
      'github',
      'atproto',
    ])
    const unset = { clientId: 'id', clientSecret: '' }
    expect(providersFor('https://rover.example', { origins: listed, github: unset })).toEqual([
      'atproto',
    ])
  })

  it('keeps AT Protocol to HTTPS and loopback origins', () => {
    expect(providersFor('http://192.168.1.20:3000', { origins: listed, github })).toEqual([
      'github',
    ])
    const dev = originPolicy('', true)
    expect(providersFor('http://localhost:3100', { origins: dev, github })).toEqual([
      'github',
      'atproto',
    ])
  })
})
