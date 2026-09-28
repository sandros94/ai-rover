import type { SettledDriveStatus } from '#shared/utils/profile'

/** How a settled drive's ending reads and is coloured. */
export const DRIVE_STATUS = {
  'arrived': { color: 'success', label: 'Arrived' },
  'stopped-short': { color: 'warning', label: 'Stopped short' },
  'failed': { color: 'error', label: 'Failed' },
} as const satisfies Record<SettledDriveStatus, { color: string; label: string }>
