import { defineHandler } from 'nitro/h3'
import { useDiscordSignIn } from '../../utils/oauth-sign-in'

/** Discord sign-in, both legs: `GET` and `POST` start it, the provider's return completes it. */
export default defineHandler((event) => useDiscordSignIn()(event))
