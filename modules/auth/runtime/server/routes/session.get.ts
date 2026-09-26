import { defineHandler } from 'nitro/h3'
import { createSessionRoutes } from '../lib/routes'
import { useAuthContext } from '../utils/auth'

export default defineHandler((event) => createSessionRoutes(useAuthContext().sessions).get(event))
