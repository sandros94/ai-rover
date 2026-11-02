import { defineHandler } from 'nitro/h3'
import { useAtprotoSignIn } from '../../utils/oauth-sign-in'

/**
 * AT Protocol sign-in, both legs: a `POST` from the login or settings form, naming the account
 * in its `handle` field, starts it; the authorization server's return completes it.
 */
export default defineHandler((event) => useAtprotoSignIn().route(event))
