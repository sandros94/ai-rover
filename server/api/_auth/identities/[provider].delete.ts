import { getValidatedRouterParams } from 'nitro/h3'
import * as v from 'valibot'
import { unlinkIdentity } from '../../../repositories/users'
import { defineAccountHandler, ProviderSchema } from '../../../utils/account'
import { BAD_INPUT } from '../../../utils/mission/validation'

const Params = v.object({ provider: ProviderSchema })

/** Detaches one of the user's identities; refused (409) for the last one. */
export default defineAccountHandler(async (event, { db, user }) => {
  const { provider } = await getValidatedRouterParams(event, Params, BAD_INPUT)
  return unlinkIdentity(db, user.id, provider)
})
