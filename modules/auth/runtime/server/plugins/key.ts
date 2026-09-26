import { definePlugin } from 'nitro'
import { useAuthContext } from '../utils/auth'

// Builds the auth context at boot, so a server without a valid NUXT_SESSION_KEY outside dev
// fails to start instead of failing its first signed-in request.
export default definePlugin(() => {
  useAuthContext()
})
