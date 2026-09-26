import { useAuthContext } from '../../../modules/auth/runtime/server/utils/auth'
import { useDB } from '../../utils/db'
import { completeSignIn } from '../../utils/sign-in'

export default defineOAuthAtprotoEventHandler({
  onSuccess: (event, result) =>
    completeSignIn(event, { db: useDB(), sessions: useAuthContext().sessions }, result),
})
