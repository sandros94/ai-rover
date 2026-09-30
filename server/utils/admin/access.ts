import type { H3Event } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import type { UserSessions } from '../../../modules/auth/runtime/server/lib/session'
import { useAuthContext } from '../../../modules/auth/runtime/server/utils/auth'
import type { DB } from '../../database/db'
import type { IdentityProvider } from '../../database/schema'
import { IDENTITY_PROVIDERS } from '../../database/schema'
import { getActiveMission } from '../../repositories/missions'
import type { Identity } from '../../repositories/users'
import { listIdentities } from '../../repositories/users'
import { useDB } from '../db'
import type { JourneyStore } from '../journey/store'
import { createJourneyStore } from '../journey/store'
import type { AdminStatus } from '#shared/utils/admin'

/** The server settings diagnostics report on, by presence only. */
export interface AdminSettings {
  sessionKey: string
  typesafeToken: string
  origins: string
}

/**
 * The identities allowed to administer, as `provider:subject` keys, and the entries of the
 * configured list that name none.
 */
export interface AdminAllowlist {
  keys: ReadonlySet<string>
  malformed: readonly string[]
}

/** What the admin routes reach beyond the request; tests pass their own. */
export interface AdminContext {
  allowlist: () => AdminAllowlist
  sessions: () => Pick<UserSessions, 'get'>
  /** Every identity linked to the account, from the database. */
  identitiesOf: (userId: string) => Promise<readonly Identity[]>
  db: () => DB
  store: () => JourneyStore
  settings: () => AdminSettings
}

/** A subject each provider can give: a DID for AT Protocol, a numeric id for the others. */
const SUBJECT: Record<IdentityProvider, RegExp> = {
  atproto: /^did:[a-z]+:\S+$/,
  github: /^\d+$/,
  discord: /^\d+$/,
}

/** An identity's key as the allowlist names it. */
export const identityKey = (identity: Identity) => `${identity.provider}:${identity.subject}`

/**
 * The allowlist `NUXT_ADMIN_IDENTITIES` configures: a comma list of `provider:subject` keys
 * (`atproto:did:plc:…`, `github:<numeric id>`, `discord:<id>`). An entry that is no such key, as
 * a GitHub login in place of its id, is left out and reported in `malformed`.
 */
export function parseAdminAllowlist(raw: string): AdminAllowlist {
  const keys = new Set<string>()
  const malformed: string[] = []
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (!entry) continue
    const colon = entry.indexOf(':')
    const provider = entry.slice(0, colon) as IdentityProvider
    const subject = entry.slice(colon + 1)
    const known = colon > 0 && (IDENTITY_PROVIDERS as readonly string[]).includes(provider)
    if (known && SUBJECT[provider].test(subject)) keys.add(entry)
    else malformed.push(entry)
  }
  return { keys, malformed }
}

/** Whether any of `identities` is on `allowlist`, provider and subject both matching exactly. */
export function isAdmin(identities: readonly Identity[], allowlist: AdminAllowlist): boolean {
  return identities.some((identity) => allowlist.keys.has(identityKey(identity)))
}

let parsed: { raw: string; allowlist: AdminAllowlist } | undefined

/** The configured allowlist, parsed once per value; its malformed entries are warned of once. */
export function configuredAllowlist(): AdminAllowlist {
  const raw = useRuntimeConfig().adminIdentities
  if (parsed && parsed.raw === raw) return parsed.allowlist
  const allowlist = parseAdminAllowlist(raw)
  if (allowlist.malformed.length) {
    console.warn(
      `[admin] NUXT_ADMIN_IDENTITIES: ignoring ${allowlist.malformed.length} entries that are no provider:subject key: ${allowlist.malformed.join(', ')}`,
    )
  }
  parsed = { raw, allowlist }
  return allowlist
}

export const PLATFORM: AdminContext = {
  allowlist: configuredAllowlist,
  sessions: () => useAuthContext().sessions,
  identitiesOf: (userId) => listIdentities(useDB(), userId),
  db: useDB,
  store: () => createJourneyStore(),
  settings: () => {
    const config = useRuntimeConfig()
    return {
      sessionKey: config.sessionKey,
      typesafeToken: config.typesafeToken,
      origins: config.oauth.origins,
    }
  },
}

const NO_STORE = { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store' }

export function noStore(event: H3Event) {
  for (const [name, value] of Object.entries(NO_STORE)) event.res.headers.set(name, value)
}

/**
 * Whether the request is an admin's: signed in to an account with any identity on the
 * allowlist, every identity the account holds counted, not only the one it signed in with.
 */
export async function adminOf(event: H3Event, context: AdminContext): Promise<boolean> {
  const allowlist = context.allowlist()
  if (allowlist.keys.size === 0) return false
  const { user } = await context.sessions().get(event)
  if (!user) return false
  return isAdmin(await context.identitiesOf(user.id), allowlist)
}

/** Refuses anyone but an admin with a 404, so the admin routes do not exist to anyone else. */
export async function requireAdmin(event: H3Event, context: AdminContext): Promise<void> {
  if (!(await adminOf(event, context))) {
    throw new HTTPError({ status: 404, message: 'Not found.', headers: NO_STORE })
  }
}

/**
 * `GET /api/admin/status`: whether the caller is an admin and, to an admin only, whether a
 * mission is active; nothing about the configuration.
 */
export function defineAdminStatusHandlerWith(context: AdminContext) {
  return defineHandler(async (event): Promise<AdminStatus> => {
    noStore(event)
    if (!(await adminOf(event, context))) return { admin: false }
    return { admin: true, missionActive: (await getActiveMission(context.db())) !== undefined }
  })
}

/** {@link defineAdminStatusHandlerWith} over the platform's configuration and sessions. */
export const defineAdminStatusHandler = () => defineAdminStatusHandlerWith(PLATFORM)
