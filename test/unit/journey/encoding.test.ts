import { describe, expect, it } from 'vitest'
import { acceptsDeflate } from '#server/utils/journey/encoding'

describe('acceptsDeflate', () => {
  it('accepts deflate when the client lists it, or a wildcard, with a non-zero weight', () => {
    const accepted = [
      'deflate',
      'gzip, deflate, br',
      'gzip, deflate;q=0.5',
      'Deflate',
      'br;q=1.0, deflate ; q=0.001',
      '*',
      'gzip, *;q=0.1',
    ]
    expect(accepted.filter((header) => !acceptsDeflate(header))).toEqual([])
  })

  it('refuses without a header, without deflate, or with deflate weighted zero', () => {
    const refused = [
      null,
      '',
      'identity',
      'gzip, br',
      'deflate;q=0',
      'deflate; q=0.000',
      '*;q=0',
      '*, deflate;q=0',
      'x-deflate',
    ]
    expect(refused.filter((header) => acceptsDeflate(header))).toEqual([])
  })
})
