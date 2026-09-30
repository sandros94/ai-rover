import { definePlugin } from 'nitro'
import { configuredAllowlist } from '../utils/admin/access'

// Parsed at startup, so a malformed allowlist entry is warned of before anyone signs in.
export default definePlugin(() => {
  configuredAllowlist()
})
