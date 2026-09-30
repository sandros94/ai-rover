import type { DriveStatus } from '#shared/utils/drive'
import type { SettledDriveStatus } from '#shared/utils/profile'

/** How a settled drive's ending reads and is coloured. */
export const DRIVE_STATUS = {
  'arrived': { color: 'success', label: 'Arrived' },
  'stopped-short': { color: 'warning', label: 'Stopped short' },
  'failed': { color: 'error', label: 'Failed' },
} as const satisfies Record<SettledDriveStatus, { color: string; label: string }>

/** The icon of what a drive is doing: moving, or stopped and why. */
export const DRIVE_STATUS_ICON: Record<DriveStatus, string> = {
  driving: 'i-lucide-navigation',
  steering: 'i-lucide-arrow-left-right',
  turning: 'i-lucide-rotate-cw',
  assessing: 'i-lucide-scan-search',
  imaging: 'i-lucide-camera',
  stopped: 'i-lucide-circle-pause',
}
