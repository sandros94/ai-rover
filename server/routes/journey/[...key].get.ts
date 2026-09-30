import { defineHandler, getRouterParam } from 'nitro/h3'
import { serveJourney } from '../../utils/journey/serve'
import { createJourneyStore } from '../../utils/journey/store'

/** Journey blobs, time-gated where a drive's future is concerned: see `serveJourney`. */
export default defineHandler((event) =>
  serveJourney(createJourneyStore(), getRouterParam(event, 'key') ?? '', {
    now: Date.now(),
    acceptEncoding: event.req.headers.get('accept-encoding'),
  }),
)
