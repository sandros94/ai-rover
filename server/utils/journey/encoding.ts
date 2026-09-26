/**
 * Whether a request's `accept-encoding` takes the stored `deflate` bytes as they are: deflate or
 * `*` listed with a non-zero weight, and deflate not refused by name. No header counts as no:
 * the blobs are deflated, and a client that names nothing may not inflate them.
 */
export function acceptsDeflate(header: string | null): boolean {
  if (!header) return false
  let named: boolean | undefined
  let wildcard = false
  for (const part of header.split(',')) {
    const [coding = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase())
    const q = params.find((p) => /^q\s*=/.test(p))
    const weight = q === undefined ? 1 : Number(q.replace(/^q\s*=\s*/, ''))
    const accepted = Number.isFinite(weight) && weight > 0
    if (coding === 'deflate') named = accepted
    else if (coding === '*') wildcard = accepted
  }
  return named ?? wildcard
}
