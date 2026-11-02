import { describe, expect, it } from 'vitest'
import { providersFor } from '#server/utils/auth-providers'
import { oauthOrigins, signInOrigins } from '#server/utils/oauth-sign-in'

const github = { clientId: 'id', clientSecret: 'secret' }
const discord = { clientId: '', clientSecret: '' }
const origins = oauthOrigins(
  'https://rover.example,http://192.168.1.20:3000,https://rover.example:8443,http://localhost:3100',
)

describe('providersFor', () => {
  it('offers nothing on an origin outside NUXT_OAUTH_ORIGINS, loopback ones included', () => {
    expect(providersFor('https://elsewhere.example', { origins, github, discord })).toEqual([])
    expect(providersFor('http://localhost', { origins, github, discord })).toEqual([])
    expect(providersFor('http://127.0.0.1:3100', { origins, github, discord })).toEqual([])
    expect(providersFor('http://localhost:3100', { origins: [], github, discord })).toEqual([])
  })

  it('offers GitHub once its app is configured, and AT Protocol on HTTPS', () => {
    expect(providersFor('https://rover.example', { origins, github, discord })).toEqual([
      'github',
      'atproto',
    ])
    const unset = { clientId: 'id', clientSecret: '' }
    expect(providersFor('https://rover.example', { origins, github: unset, discord })).toEqual([
      'atproto',
    ])
  })

  it('offers Discord once its app is configured, after GitHub', () => {
    const set = { clientId: 'id', clientSecret: 'secret' }
    expect(providersFor('https://rover.example', { origins, github, discord: set })).toEqual([
      'github',
      'discord',
      'atproto',
    ])
  })

  it('keeps AT Protocol to HTTPS origins without a port and loopback ones', () => {
    expect(providersFor('http://192.168.1.20:3000', { origins, github, discord })).toEqual([
      'github',
    ])
    expect(providersFor('https://rover.example:8443', { origins, github, discord })).toEqual([
      'github',
    ])
    expect(providersFor('http://localhost:3100', { origins, github, discord })).toEqual([
      'github',
      'atproto',
    ])
  })
})

describe('signInOrigins', () => {
  it("joins NUXT_OAUTH_ORIGINS and the site's main address, each origin once", () => {
    expect(
      signInOrigins({
        origins: 'https://rover.example/, http://localhost:3000',
        siteUrl: 'https://rover.example',
        deployUrls: '',
      }),
    ).toEqual({ origins: ['https://rover.example', 'http://localhost:3000'], deployOrigins: [] })
    expect(
      signInOrigins({ origins: '', siteUrl: 'https://rover.example', deployUrls: '' }).origins,
    ).toEqual(['https://rover.example'])
  })

  it("keeps the deploy's own addresses apart, without those every provider signs in on", () => {
    expect(
      signInOrigins({
        origins: 'https://rover.example',
        siteUrl: 'https://rover.netlify.app',
        deployUrls:
          'https://deploy-preview-12--rover.netlify.app,https://5b24--rover.netlify.app,https://rover.example',
      }),
    ).toEqual({
      origins: ['https://rover.example', 'https://rover.netlify.app'],
      deployOrigins: [
        'https://deploy-preview-12--rover.netlify.app',
        'https://5b24--rover.netlify.app',
      ],
    })
  })
})

describe("providersFor on the deploy's own addresses", () => {
  const set = { clientId: 'id', clientSecret: 'secret' }
  const deployOrigins = ['https://deploy-preview-12--rover.netlify.app']

  it('offers AT Protocol alone there, every configured provider on the listed origins', () => {
    const config = { origins, deployOrigins, github, discord: set }
    expect(providersFor('https://deploy-preview-12--rover.netlify.app', config)).toEqual([
      'atproto',
    ])
    expect(providersFor('https://rover.example', config)).toEqual(['github', 'discord', 'atproto'])
  })
})
