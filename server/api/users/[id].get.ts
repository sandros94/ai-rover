import { defineHandler, getValidatedRouterParams } from 'nitro/h3'
import { profileStats } from '#shared/utils/profile'
import { getPublicProfile } from '../../repositories/profiles'
import { useDB } from '../../utils/db'
import { httpErrorOf } from '../../utils/mission/http'
import { BAD_INPUT, UserParams } from '../../utils/mission/validation'

/**
 * A user's public profile: who they are, their tally and their submissions, all of it what the
 * vote cards and the journey already show. Browsers keep it a minute.
 */
export default defineHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, UserParams, BAD_INPUT)
  try {
    const profile = await getPublicProfile(useDB(), id)
    event.res.headers.set('cache-control', 'public, max-age=60')
    return { ...profile, stats: profileStats(profile.submissions) }
  } catch (error) {
    throw httpErrorOf(error)
  }
})
