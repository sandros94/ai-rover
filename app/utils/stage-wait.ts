/**
 * What a stop's stage waits for before it draws the stop true: the terrain's chunks, counted;
 * the stop's seen mask, without which the fog is unknown; or the playing drive's record, whose
 * first frame places the rover.
 */
export type StageWait =
  | { what: 'terrain'; loaded: number; total: number }
  | { what: 'mask' }
  | { what: 'drive' }

/** How the loading indicator words `wait`. */
export function stageWaitLabel(wait: StageWait): string {
  switch (wait.what) {
    case 'terrain':
      return `Loading terrain ${wait.loaded} / ${wait.total || '…'}`
    case 'mask':
      return 'Loading the ground the rover has seen'
    case 'drive':
      return "Loading the drive's record"
  }
}
