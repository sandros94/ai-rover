/// <reference lib="webworker" />
import type { StopDisk } from '#shared/utils/terrain'
import { diskFromTerrain, previewPlan } from '#shared/utils/client'
import type { PlanWorkerRequest, PlanWorkerResponse } from './plan-protocol'

declare const self: DedicatedWorkerGlobalScope

let ground: { disk: StopDisk; revealed: Uint8Array; slopeLimitDeg: number } | undefined

function post(message: PlanWorkerResponse): void {
  self.postMessage(message)
}

self.addEventListener('message', (event: MessageEvent<PlanWorkerRequest>) => {
  const message = event.data
  if (message.type === 'ground') {
    const began = performance.now()
    try {
      const { grid, origin, traversable, revealed, center, radius, chunks, mastHeight } =
        message.ground
      const disk = diskFromTerrain(
        { grid, origin, traversable },
        { stop: center, radius, chunks, world: { mastHeight } },
      )
      ground = { disk, revealed, slopeLimitDeg: message.ground.slopeLimitDeg }
      post({ type: 'ready', buildMs: performance.now() - began })
    } catch (error) {
      post({ type: 'error', id: null, message: String(error) })
    }
    return
  }
  if (!ground) {
    post({ type: 'error', id: message.id, message: 'The planner has no ground yet.' })
    return
  }
  const began = performance.now()
  try {
    const result = previewPlan(ground.disk, {
      revealed: ground.revealed,
      anchor: message.anchor,
      point: message.point,
      deaths: message.deaths,
      rules: message.rules,
      slopeLimitDeg: ground.slopeLimitDeg,
    })
    post({ type: 'result', id: message.id, result, planMs: performance.now() - began })
  } catch (error) {
    post({ type: 'error', id: message.id, message: String(error) })
  }
})
