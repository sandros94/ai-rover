import { defineHandler } from 'nitro/h3'
import { useAtprotoSignIn } from '../../../utils/oauth-sign-in'

/**
 * The AT Protocol client metadata document of this origin, at its `client_id`; 404 on an origin
 * that publishes none (a loopback one, whose development client has none, or an unlisted one).
 */
export default defineHandler((event) => useAtprotoSignIn().metadata(event))
