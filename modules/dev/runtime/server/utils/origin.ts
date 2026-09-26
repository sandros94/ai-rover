/**
 * Whether a request was sent by a page of the dev server itself (same host and port): its
 * `Origin`, or its `Referer` when it sends no `Origin`. A page on another site can make a
 * browser post to the dev server, but it cannot make the browser name the dev server as the
 * origin; the DevTools panel is served by the dev server, so its requests pass.
 */
export function isSameOrigin(request: Request): boolean {
  const own = new URL(request.url).host
  const source = request.headers.get('origin') || request.headers.get('referer')
  if (!source) return false
  try {
    return new URL(source).host === own
  } catch {
    return false
  }
}
