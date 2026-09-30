import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredAllowlist, isAdmin, parseAdminAllowlist } from '#server/utils/admin/access'

const config = vi.hoisted(() => ({ adminIdentities: '' }))
vi.mock('nitro/runtime-config', () => ({ useRuntimeConfig: () => config }))

afterEach(() => vi.restoreAllMocks())

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

describe('parseAdminAllowlist', () => {
  it('keeps each provider:subject key, trimmed, and reports every other entry', () => {
    const { keys, malformed } = parseAdminAllowlist(
      ` atproto:${DID},github:583231 ,, discord:80351110224678912,github:octocat,gitlab:1,${DID},discord:,atproto:plc:x`,
    )
    expect([...keys]).toEqual([`atproto:${DID}`, 'github:583231', 'discord:80351110224678912'])
    expect(malformed).toEqual(['github:octocat', 'gitlab:1', DID, 'discord:', 'atproto:plc:x'])
  })

  it('allows nobody when empty', () => {
    expect(parseAdminAllowlist('')).toEqual({ keys: new Set(), malformed: [] })
    expect(parseAdminAllowlist(' , ')).toEqual({ keys: new Set(), malformed: [] })
  })
})

describe('isAdmin', () => {
  const allowlist = parseAdminAllowlist(`atproto:${DID},github:583231`)

  it('matches any of the identities, provider and subject exactly', () => {
    expect(isAdmin([{ provider: 'github', subject: '583231' }], allowlist)).toBe(true)
    expect(
      isAdmin(
        [
          { provider: 'discord', subject: '80351110224678912' },
          { provider: 'atproto', subject: DID },
        ],
        allowlist,
      ),
    ).toBe(true)
  })

  it('refuses a subject under another provider, a prefix, a case change or no identity', () => {
    expect(isAdmin([{ provider: 'discord', subject: '583231' }], allowlist)).toBe(false)
    expect(isAdmin([{ provider: 'github', subject: '58323' }], allowlist)).toBe(false)
    expect(isAdmin([{ provider: 'atproto', subject: DID.toUpperCase() }], allowlist)).toBe(false)
    expect(isAdmin([], allowlist)).toBe(false)
  })

  it('refuses everyone on an empty allowlist', () => {
    expect(isAdmin([{ provider: 'github', subject: '583231' }], parseAdminAllowlist(''))).toBe(
      false,
    )
  })
})

describe('configuredAllowlist', () => {
  it('warns of the malformed entries once per configured value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    config.adminIdentities = 'github:583231,github:octocat'
    expect([...configuredAllowlist().keys]).toEqual(['github:583231'])
    configuredAllowlist()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('github:octocat')

    config.adminIdentities = 'github:583231'
    configuredAllowlist()
    expect(warn).toHaveBeenCalledOnce()
  })
})
