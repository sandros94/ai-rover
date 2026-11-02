import { HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { TerrainError } from '#shared/utils/terrain'
import { MissionExistsError, seedLocalMission } from '../../utils/seed'
import { defineDevWriteHandler } from '../../utils/write'

const finite = v.pipe(v.number(), v.finite())

const BodySchema = v.optional(
  v.object({
    seed: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    x: v.optional(finite),
    y: v.optional(finite),
  }),
  {},
)

/**
 * Lands a mission on the empty local database, published to the local journey store. Accepted
 * only from the dev server's own pages (403 otherwise); refuses (403) while the database is not
 * on this machine and (409) once it has a mission.
 */
export default defineDevWriteHandler(async (event) => {
  const input = await readValidatedBody(event, BodySchema, {
    onError: (result) => ({
      status: 400,
      message: result.issues
        .map(
          (issue) =>
            `${issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') ?? 'body'}: ${issue.message}`,
        )
        .join('; '),
    }),
  })
  try {
    return await seedLocalMission(process.env.NETLIFY_DB_URL, input)
  } catch (error) {
    if (error instanceof MissionExistsError) throw new HTTPError(error.message, { status: 409 })
    if (error instanceof TerrainError) throw new HTTPError(error.message, { status: 400 })
    throw error
  }
})
