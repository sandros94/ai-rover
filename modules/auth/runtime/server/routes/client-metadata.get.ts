import { defineHandler } from 'nitro/h3'
import { createClientMetadataHandler } from '../lib/atproto/handler'
import { useAuthContext } from '../utils/auth'

let handler: ReturnType<typeof createClientMetadataHandler> | undefined

export default defineHandler((event) =>
  (handler ??= createClientMetadataHandler(useAuthContext()))(event),
)
