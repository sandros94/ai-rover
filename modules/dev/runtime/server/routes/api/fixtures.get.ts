import { defineHandler } from 'nitro/h3'
import { FIXTURE_NAMES } from '../../utils/fixtures'

/** Names of the drive records the playground can load; each is driven on first request. */
export default defineHandler(() => [...FIXTURE_NAMES])
