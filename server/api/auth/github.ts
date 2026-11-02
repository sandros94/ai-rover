import { defineHandler } from 'nitro/h3'
import { useGitHubSignIn } from '../../utils/oauth-sign-in'

/** GitHub sign-in, both legs: `GET` and `POST` start it, the provider's return completes it. */
export default defineHandler((event) => useGitHubSignIn()(event))
