/*
 * Brings a mission up to date outside any public request. The `-background` suffix makes it a
 * Background Function: the platform answers 202 at once and lets it run up to 15 minutes.
 *
 * Bundled by the platform, not by Nitro: everything it imports must be free of `nitro/*`, and the
 * bundler resolves `#shared` only through the root tsconfig's `paths`.
 */
import { jevCacheOver } from '../../server/repositories/judgments'
import { useDB } from '../../server/utils/db'
import {
  createJevClient,
  JEV_SERVER_LIMITS,
  jevCredentialsOf,
  lazyJevClient,
} from '../../server/utils/jev/client'
import { createJourneyStore } from '../../server/utils/journey/store'
import { runTickRequest, tickToken } from '../../server/utils/mission/background'
import { tickMission } from '../../server/utils/mission/tick'

/** Whether this runs under `nuxt dev`, whose local emulation sets both. */
function isDev(): boolean {
  return process.env.NETLIFY_LOCAL === 'true' && process.env.CONTEXT === 'dev'
}

export default async (request: Request): Promise<void> => {
  await runTickRequest(request, {
    token: () => tickToken(process.env.NUXT_SESSION_KEY ?? '', isDev()),
    tick: (missionId) => {
      const db = useDB()
      const jev = lazyJevClient(() =>
        createJevClient({
          ...jevCredentialsOf(process.env.NUXT_TYPESAFE_TOKEN),
          ...JEV_SERVER_LIMITS,
          cache: jevCacheOver(db),
        }),
      )
      return tickMission(db, {
        missionId,
        store: createJourneyStore(),
        jev,
        now: new Date(),
        lock: 'try',
      })
    },
  })
}
