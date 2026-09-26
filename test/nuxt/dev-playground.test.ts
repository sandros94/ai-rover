import { describe, expect, it } from 'vitest'
import { PLAYGROUND_ENTRIES } from '~~/modules/dev/runtime/app/playground/registry'

describe('playground registry', () => {
  it('has unique ids', () => {
    const ids = PLAYGROUND_ENTRIES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(PLAYGROUND_ENTRIES.map((entry) => [entry.id, entry] as const))(
    '%s resolves to a component',
    async (_id, entry) => {
      const module = await entry.component()
      expect(module.default).toBeTruthy()
    },
  )
})
