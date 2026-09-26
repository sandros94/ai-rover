import { HTTPError } from 'nitro/h3'
import { fetchPublic, publicHttpsUrl, readCapped, readJsonObject } from '../http'

export interface ResolvedIdentity {
  did: string
  /** Present only when the handle and the DID document point at each other. */
  handle?: string
  /** Origin of the account's PDS. */
  pds: string
}

// Handle and DID syntax per the atproto Handle and DID specs.
const HANDLE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const DISALLOWED_TLDS = [
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
]
const DID_PLC = /^did:plc:[a-z2-7]{24}$/
const DID_WEB = /^did:web:([a-z0-9.-]+)$/

const DOH = 'https://cloudflare-dns.com/dns-query'
const PLC_DIRECTORY = 'https://plc.directory'

/**
 * Handle or DID → DID document → PDS, with the handle verified in both directions. Starting from
 * a handle, a document not claiming it is refused; starting from a DID, an unverified handle is
 * dropped. `did:plc` and host-only `did:web` are the methods atproto blesses.
 */
export async function resolveIdentity(
  input: string,
  fetch: typeof globalThis.fetch,
): Promise<ResolvedIdentity> {
  const identifier = input.trim().replace(/^@/, '')
  if (identifier.startsWith('did:')) {
    assertDid(identifier)
    const document = await resolveDid(identifier, fetch)
    const claimed = claimedHandle(document)
    const handle =
      claimed && (await resolveHandle(claimed, fetch).catch(() => undefined)) === identifier
        ? claimed
        : undefined
    return { did: identifier, ...(handle && { handle }), pds: pdsOf(document) }
  }
  const handle = normalizeHandle(identifier)
  const did = await resolveHandle(handle, fetch)
  const document = await resolveDid(did, fetch)
  if (claimedHandle(document) !== handle) {
    throw new HTTPError({ status: 400, message: `${did} does not claim the handle ${handle}.` })
  }
  return { did, handle, pds: pdsOf(document) }
}

export function normalizeHandle(value: string): string {
  const handle = value.toLowerCase()
  const tld = handle.slice(handle.lastIndexOf('.') + 1)
  if (handle.length > 253 || !HANDLE.test(handle) || DISALLOWED_TLDS.includes(tld)) {
    throw new HTTPError({ status: 400, message: `"${value}" is not an atproto handle or DID.` })
  }
  return handle
}

function assertDid(did: string) {
  const web = DID_WEB.exec(did)
  if (DID_PLC.test(did) || (web && HANDLE.test(web[1]!) && !/^[\d.]+$/.test(web[1]!))) return
  throw new HTTPError({ status: 400, message: `"${did}" is not a did:plc or host-only did:web.` })
}

/** DNS TXT `_atproto.<handle>` over DNS-over-HTTPS, then the HTTPS well-known. */
async function resolveHandle(handle: string, fetch: typeof globalThis.fetch): Promise<string> {
  const fromDns = await resolveHandleDns(handle, fetch).catch(() => undefined)
  const did = fromDns ?? (await resolveHandleHttps(handle, fetch))
  assertDid(did)
  return did
}

async function resolveHandleDns(handle: string, fetch: typeof globalThis.fetch) {
  const url = new URL(DOH)
  url.search = new URLSearchParams({ name: `_atproto.${handle}`, type: 'TXT' }).toString()
  const response = await fetchPublic(fetch, url, { headers: { accept: 'application/dns-json' } })
  if (!response.ok) return undefined
  const body = await readJsonObject(response, 'The DNS answer')
  const answers = Array.isArray(body.Answer) ? (body.Answer as Array<Record<string, unknown>>) : []
  const dids = new Set(
    answers
      .filter((answer) => answer.type === 16 && typeof answer.data === 'string')
      // A TXT record arrives as one or more quoted character-strings.
      .map((answer) => (answer.data as string).replace(/"\s*"/g, '').replace(/^"|"$/g, ''))
      .filter((text) => text.startsWith('did='))
      .map((text) => text.slice(4)),
  )
  if (dids.size > 1) {
    throw new HTTPError({ status: 400, message: `${handle} has conflicting DNS records.` })
  }
  return dids.values().next().value
}

async function resolveHandleHttps(handle: string, fetch: typeof globalThis.fetch) {
  const response = await fetchPublic(fetch, `https://${handle}/.well-known/atproto-did`, {
    status: 400,
  }).catch(() => undefined)
  if (!response?.ok) {
    throw new HTTPError({ status: 400, message: `The handle ${handle} does not resolve.` })
  }
  return (await readCapped(response, 'The handle document', 400)).split('\n')[0]!.trim()
}

type DidDocument = Record<string, unknown>

async function resolveDid(did: string, fetch: typeof globalThis.fetch): Promise<DidDocument> {
  const url = did.startsWith('did:plc:')
    ? `${PLC_DIRECTORY}/${did}`
    : `https://${did.slice('did:web:'.length)}/.well-known/did.json`
  const response = await fetchPublic(fetch, url)
  if (!response.ok) {
    throw new HTTPError({ status: 400, message: `The DID document of ${did} is unavailable.` })
  }
  const document = await readJsonObject(response, `The DID document of ${did}`, 400)
  if (document.id !== did) {
    throw new HTTPError({
      status: 400,
      message: `The DID document fetched for ${did} is another's.`,
    })
  }
  return document
}

/** The first `at://` entry of `alsoKnownAs`, which is the account's handle claim. */
function claimedHandle(document: DidDocument): string | undefined {
  const aliases = Array.isArray(document.alsoKnownAs) ? document.alsoKnownAs : []
  const alias = aliases.find(
    (entry): entry is string => typeof entry === 'string' && entry.startsWith('at://'),
  )
  return alias?.slice('at://'.length).toLowerCase()
}

function pdsOf(document: DidDocument): string {
  const services = Array.isArray(document.service) ? (document.service as DidDocument[]) : []
  const service = services.find(
    (entry) =>
      (entry.id === '#atproto_pds' || entry.id === `${document.id as string}#atproto_pds`) &&
      entry.type === 'AtprotoPersonalDataServer' &&
      typeof entry.serviceEndpoint === 'string',
  )
  if (!service) {
    throw new HTTPError({ status: 400, message: `${document.id as string} names no PDS.` })
  }
  return publicHttpsUrl(service.serviceEndpoint as string, 400).origin
}
