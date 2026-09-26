/**
 * `source` sampled at most `hz` times per second: a change inside the interval is delivered at
 * its end, so the last value always lands.
 */
export function useThrottled<T>(source: () => T, hz: number) {
  const interval = 1000 / hz
  const value = shallowRef<T>(source())
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush(): void {
    timer = undefined
    last = performance.now()
    value.value = source()
  }

  watch(source, () => {
    if (timer) return
    const wait = last + interval - performance.now()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  })
  onScopeDispose(() => clearTimeout(timer))

  return value
}
