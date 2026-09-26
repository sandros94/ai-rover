import { ROVER_ID } from '#shared/utils/client'

/**
 * The object the map is focused on, by id (`stop:3`, `death:<segment>`, `submission:<id>`,
 * `rover`), or null: both views centre on it and a page shows its details. `seq` counts every
 * focus, so focusing the same object again (the recentre control, pressed twice) still moves the
 * views. Shared by the whole page; a page clears it when it leaves.
 */
export function useMapFocus() {
  const state = useState<{ id: string | null; seq: number }>('jev-rover:focus', () => ({
    id: null,
    seq: 0,
  }))

  const focused = computed(() => state.value.id)
  const seq = computed(() => state.value.seq)

  function focusOn(id: string): void {
    state.value = { id, seq: state.value.seq + 1 }
  }

  /** Back to the rover: the recentre control. */
  function recentre(): void {
    focusOn(ROVER_ID)
  }

  function clear(): void {
    if (state.value.id !== null) state.value = { id: null, seq: state.value.seq + 1 }
  }

  return { focused, seq, focusOn, recentre, clear }
}
