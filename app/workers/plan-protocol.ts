import type { PreviewResult } from '#shared/utils/client'
import type { MapPoint, MissionRules } from '#shared/utils/mission'
import type { ChunkCoords, GridCell, HeightGrid } from '#shared/utils/terrain'

/** Everything the planner needs about one stop, sent to the worker once. */
export interface PlanGround {
  grid: HeightGrid
  origin: GridCell
  /** One byte per grid vertex, as the chunks mark it. */
  traversable: Uint8Array
  /** One byte per grid vertex, as `revealedOverDisk` gives it. */
  revealed: Uint8Array
  center: MapPoint
  radius: number
  chunks: ChunkCoords[]
  mastHeight: number
  slopeLimitDeg: number
}

/** What a preview is measured against; changes with the round, not with the ground. */
export interface PlanContext {
  anchor: MapPoint
  deaths: MapPoint[]
  rules: MissionRules
}

export type PlanWorkerRequest =
  | { type: 'ground'; ground: PlanGround }
  | ({ type: 'plan'; id: number; point: MapPoint } & PlanContext)

export type PlanWorkerResponse =
  | { type: 'ready'; buildMs: number }
  | { type: 'result'; id: number; result: PreviewResult; planMs: number }
  | { type: 'error'; id: number | null; message: string }
