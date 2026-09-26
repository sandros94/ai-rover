import type { Component, PropType } from 'vue'
import type { DriveEvent, SegmentRecord } from '#shared/utils/drive'
import type { DiskWire } from '../../shared/disk-wire'

/** What an entry needs from the frame beyond the time scrubber. */
export type PlaygroundNeed = 'record' | 'disk'

/**
 * Props every playground component receives from the frame, as a runtime declaration: the SFC
 * compiler cannot resolve a props type imported from another file under TypeScript 7.
 */
export const PLAYGROUND_PROPS = {
  record: { type: Object as PropType<SegmentRecord>, required: true },
  /** The 19 keyframe values at the scrub time, as `interpolatePose` returns them. */
  frame: { type: Float32Array, required: true },
  /** Record events at or before the scrub time. */
  events: { type: Array as PropType<DriveEvent[]>, required: true },
  /** The stop disk at the record's start; present when the entry needs `disk`. */
  disk: { type: Object as PropType<DiskWire>, default: undefined },
} as const

export interface PlaygroundEntry {
  /** URL segment under `/_dev/playground/`. */
  id: string
  title: string
  group: 'instrument' | 'scene' | 'card'
  component: () => Promise<{ default: Component }>
  needs: PlaygroundNeed[]
}

export const PLAYGROUND_ENTRIES: PlaygroundEntry[] = [
  {
    id: 'attitude',
    title: 'Attitude readout',
    group: 'instrument',
    component: () =>
      // @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
      import('../components/playground/AttitudeReadout.vue'),
    needs: ['record'],
  },
]
