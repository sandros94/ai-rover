import { readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { setPrimaryProvider } from '../../repositories/users'
import { defineAccountHandler, ProviderSchema } from '../../utils/account'
import { BAD_INPUT } from '../../utils/mission/validation'

const BodySchema = v.strictObject({ primaryProvider: ProviderSchema })

/** Picks which of the user's identities supplies their name and avatar. */
export default defineAccountHandler(async (event, { db, user }) => {
  const { primaryProvider } = await readValidatedBody(event, BodySchema, BAD_INPUT)
  return setPrimaryProvider(db, user.id, primaryProvider)
})
