import type { MaybeRefOrGetter } from 'vue'
import type { PreviewResult } from '#shared/utils/client'
import type { MapPoint } from '#shared/utils/mission'
import type {
  PlanContext,
  PlanGround,
  PlanWorkerRequest,
  PlanWorkerResponse,
} from '../workers/plan-protocol'

/** Quiet time after the last hover before a preview is planned. */
export const PREVIEW_DEBOUNCE_MS = 60

/**
 * Route previews planned in a Web Worker over `ground`, sent to the worker once each time it
 * changes (copies: the caller keeps its arrays). At most one plan is in flight; a request made
 * meanwhile replaces any other waiting one, so a stale point is never planned after a newer one.
 * `request` debounces (hover), `requestNow` does not (tap).
 */
export function usePlanPreview(
  ground: MaybeRefOrGetter<PlanGround | undefined>,
  context: MaybeRefOrGetter<PlanContext | undefined>,
) {
  const ready = ref(false)
  const pending = ref(false)
  const result = shallowRef<PreviewResult>()
  /** Point `result` was planned for. */
  const point = shallowRef<MapPoint>()
  const planMs = ref<number>()
  const buildMs = ref<number>()
  const error = ref<string | null>(null)

  let worker: Worker | undefined
  let nextId = 0
  let inFlight: { id: number; point: MapPoint } | undefined
  let waiting: MapPoint | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function send(message: PlanWorkerRequest, transfer: Transferable[] = []): void {
    worker?.postMessage(message, transfer)
  }

  function dispatch(): void {
    const ctx = toValue(context)
    if (!worker || !ready.value || inFlight || !waiting || !ctx) return
    const id = ++nextId
    inFlight = { id, point: waiting }
    waiting = undefined
    pending.value = true
    send({
      type: 'plan',
      id,
      point: { ...inFlight.point },
      anchor: { ...ctx.anchor },
      deaths: ctx.deaths.map(({ x, y }) => ({ x, y })),
      rules: structuredClone(toRaw(ctx.rules)),
    })
  }

  function onMessage(event: MessageEvent<PlanWorkerResponse>): void {
    const message = event.data
    if (message.type === 'ready') {
      ready.value = true
      buildMs.value = message.buildMs
      dispatch()
      return
    }
    if (message.id !== null && message.id !== inFlight?.id) return
    const asked = inFlight?.point
    inFlight = undefined
    pending.value = waiting !== undefined
    if (message.type === 'error') {
      error.value = message.message
    } else if (!waiting) {
      // A newer point waiting makes this answer stale; only the latest is shown.
      error.value = null
      result.value = message.result
      point.value = asked
      planMs.value = message.planMs
    }
    dispatch()
  }

  function loadGround(next: PlanGround | undefined): void {
    ready.value = false
    inFlight = undefined
    if (!worker || !next) return
    const copy: PlanGround = {
      ...next,
      grid: { ...next.grid, heights: next.grid.heights.slice() },
      origin: { ...next.origin },
      traversable: next.traversable.slice(),
      revealed: next.revealed.slice(),
      center: { ...next.center },
      chunks: next.chunks.map(({ cx, cy }) => ({ cx, cy })),
    }
    send({ type: 'ground', ground: copy }, [
      copy.grid.heights.buffer,
      copy.traversable.buffer,
      copy.revealed.buffer,
    ])
  }

  function requestNow(at: MapPoint): void {
    clearTimeout(timer)
    waiting = at
    dispatch()
  }

  function request(at: MapPoint): void {
    clearTimeout(timer)
    timer = setTimeout(() => requestNow(at), PREVIEW_DEBOUNCE_MS)
  }

  function clear(): void {
    clearTimeout(timer)
    waiting = undefined
    result.value = undefined
    point.value = undefined
  }

  onMounted(() => {
    worker = new Worker(new URL('../workers/plan.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', onMessage)
    watch(() => toValue(ground), loadGround, { immediate: true })
    // A new anchor, death or rule (the round moved) makes the shown plan stale: plan it again.
    watch(
      () => JSON.stringify(toValue(context) ?? null),
      () => {
        if (point.value && !waiting && !inFlight) requestNow(point.value)
      },
    )
  })
  onBeforeUnmount(() => {
    clearTimeout(timer)
    worker?.terminate()
    worker = undefined
  })

  return { ready, pending, result, point, planMs, buildMs, error, request, requestNow, clear }
}
