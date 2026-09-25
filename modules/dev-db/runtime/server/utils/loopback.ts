const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether `url` names a database on this machine. `NETLIFY_DB_URL` is the one source the driver
 * resolves from, so every writing surface checks it here first and leaves any other host alone.
 */
export function isLoopback(url: string | undefined): boolean {
  if (!url) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Host and port of `url` for display; a connection string carries credentials, so never more. */
export function databaseHost(url: string | undefined): string {
  if (!url) return '(unset)'
  try {
    return new URL(url).host
  } catch {
    return '(unparseable)'
  }
}
