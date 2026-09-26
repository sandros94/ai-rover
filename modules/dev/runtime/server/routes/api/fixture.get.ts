import { defineHandler, getRouterParam, HTTPError } from 'nitro/h3'
import type { SegmentRecordJson } from '../../../shared/record-json'
import { recordToJson } from '../../../shared/record-json'
import { fixtureRecord } from '../../utils/fixtures'

/** One fixture drive record as JSON (`record-json`). */
export default defineHandler((event): SegmentRecordJson => {
  const name = getRouterParam(event, 'name') ?? ''
  const record = fixtureRecord(name)
  if (!record) throw new HTTPError(`No fixture named "${name}".`, { status: 404 })
  return recordToJson(record)
})
