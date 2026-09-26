import type { JourneyClient } from '#shared/utils/client'
import { createJourneyClient } from '#shared/utils/client'

let client: JourneyClient | undefined

/**
 * The journey client over `/journey`, shared by the whole app; it holds no state. Browser only:
 * the relative base URL does not resolve during server rendering.
 */
export function useJourneyClient(): JourneyClient {
  client ??= createJourneyClient()
  return client
}
