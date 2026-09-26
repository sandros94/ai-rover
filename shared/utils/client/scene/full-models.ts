/**
 * Full rover models in a scene at once: the rover itself and the one focused ghost. Ghosts draw a
 * low-poly silhouette and gain the full model only while focused.
 */
export const MAX_FULL_MODELS = 2

/**
 * Who may draw a full rover model. A request is granted at once while fewer than `max` hold one
 * (or when the id already holds one), else it waits, first come first served, until a holder
 * releases; releasing a waiting request withdraws it. Grants are callbacks, so a waiting ghost
 * swaps in the moment a slot frees.
 */
export interface FullModelLedger {
  request(id: string, grant: () => void): void
  release(id: string): void
  /** Ids holding a full model, in the order they were granted. */
  readonly holders: readonly string[]
  /** Ids waiting, first first. */
  readonly waiting: readonly string[]
}

export function fullModelLedger(options: { max?: number } = {}): FullModelLedger {
  const max = options.max ?? MAX_FULL_MODELS
  const holders: string[] = []
  const queue: { id: string; grant: () => void }[] = []

  function drain(): void {
    while (holders.length < max && queue.length > 0) {
      const next = queue.shift()!
      holders.push(next.id)
      next.grant()
    }
  }

  return {
    request(id, grant) {
      if (holders.includes(id)) return grant()
      const waiting = queue.findIndex((entry) => entry.id === id)
      if (waiting >= 0) queue.splice(waiting, 1)
      queue.push({ id, grant })
      drain()
    },
    release(id) {
      const held = holders.indexOf(id)
      if (held >= 0) holders.splice(held, 1)
      const waiting = queue.findIndex((entry) => entry.id === id)
      if (waiting >= 0) queue.splice(waiting, 1)
      drain()
    },
    get holders() {
      return [...holders]
    },
    get waiting() {
      return queue.map((entry) => entry.id)
    },
  }
}
