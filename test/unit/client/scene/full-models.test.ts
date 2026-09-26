import { describe, expect, it, vi } from 'vitest'
import { fullModelLedger, MAX_FULL_MODELS } from '#shared/utils/client/scene'

describe('fullModelLedger', () => {
  it('allows two full models: the rover and one focused ghost', () => {
    expect(MAX_FULL_MODELS).toBe(2)
    const ledger = fullModelLedger()
    const rover = vi.fn<() => void>()
    const ghost = vi.fn<() => void>()
    ledger.request('rover', rover)
    ledger.request('ghost:a', ghost)
    expect(rover).toHaveBeenCalledOnce()
    expect(ghost).toHaveBeenCalledOnce()
    expect(ledger.holders).toEqual(['rover', 'ghost:a'])
  })

  it('makes a third wait until a holder releases, then grants it', () => {
    const ledger = fullModelLedger()
    ledger.request('rover', () => {})
    ledger.request('ghost:a', () => {})
    const third = vi.fn<() => void>()
    ledger.request('ghost:b', third)
    expect(third).not.toHaveBeenCalled()
    expect(ledger.holders).toHaveLength(2)
    expect(ledger.waiting).toEqual(['ghost:b'])

    ledger.release('ghost:a')
    expect(third).toHaveBeenCalledOnce()
    expect(ledger.holders).toEqual(['rover', 'ghost:b'])
    expect(ledger.waiting).toEqual([])
  })

  it('never holds more than its maximum however requests and releases interleave', () => {
    const ledger = fullModelLedger()
    const ids = ['rover', 'a', 'b', 'c', 'd']
    let most = 0
    for (let step = 0; step < 200; step++) {
      const id = ids[(step * 7) % ids.length]!
      if ((step * 13) % 3 === 0) ledger.release(id)
      else ledger.request(id, () => {})
      most = Math.max(most, ledger.holders.length)
      expect(new Set(ledger.holders).size).toBe(ledger.holders.length)
    }
    expect(most).toBe(MAX_FULL_MODELS)
  })

  it('drops a waiting request on release, so it is never granted', () => {
    const ledger = fullModelLedger({ max: 1 })
    ledger.request('rover', () => {})
    const late = vi.fn<() => void>()
    ledger.request('ghost:a', late)
    ledger.release('ghost:a')
    ledger.release('rover')
    expect(late).not.toHaveBeenCalled()
    expect(ledger.holders).toEqual([])
  })

  it('grants a holder asking again at once, without taking a second slot', () => {
    const ledger = fullModelLedger()
    ledger.request('rover', () => {})
    const again = vi.fn<() => void>()
    ledger.request('rover', again)
    expect(again).toHaveBeenCalledOnce()
    expect(ledger.holders).toEqual(['rover'])
  })

  it('keeps the latest callback of a request made twice while waiting', () => {
    const ledger = fullModelLedger({ max: 1 })
    ledger.request('rover', () => {})
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    ledger.request('ghost:a', first)
    ledger.request('ghost:a', second)
    expect(ledger.waiting).toEqual(['ghost:a'])
    ledger.release('rover')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
})
