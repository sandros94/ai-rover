import type { Ref } from 'vue'

/**
 * Raises the site credit over the widgets a scene page keeps in its lower-left corner: the HUD's
 * bottom row (`data-hud-bottom`) in `hud`, and the elements marked `data-scene-widget` in `scene`,
 * those reaching under the credit's span. It sets `--credits-lift` on the document, in pixels from
 * the viewport's foot to the highest of them, while the calling component is mounted.
 */
export function useCreditsLift(
  scene: Readonly<Ref<HTMLElement | null>>,
  hud: Readonly<Ref<HTMLElement | null>>,
): void {
  const lift = ref(0)
  useHead({ htmlAttrs: { style: computed(() => `--credits-lift: ${lift.value}px`) } })

  function measure(): void {
    const credits = document.querySelector('[data-site-credits]')?.getBoundingClientRect()
    if (!credits) return
    const floor = document.documentElement.clientHeight
    const widgets = [
      ...(hud.value?.querySelectorAll('[data-hud-bottom] > *') ?? []),
      ...(scene.value?.querySelectorAll('[data-scene-widget]') ?? []),
    ]
    let top = floor
    for (const widget of widgets) {
      const rect = widget.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (rect.left < credits.right && rect.right > credits.left) top = Math.min(top, rect.top)
    }
    lift.value = Math.max(0, Math.round(floor - top))
  }

  // Widgets come and go with the view and the data, and the bottom row resizes with its content.
  let frame = 0
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
  }
  let resizes: ResizeObserver | undefined
  let mutations: MutationObserver | undefined
  onMounted(() => {
    schedule()
    if (typeof ResizeObserver === 'undefined') return
    resizes = new ResizeObserver(schedule)
    for (const el of [scene.value, hud.value, hud.value?.querySelector('[data-hud-bottom]')]) {
      if (el) resizes.observe(el)
    }
    const credits = document.querySelector('[data-site-credits]')
    if (credits) resizes.observe(credits)
    mutations = new MutationObserver(schedule)
    for (const el of [scene.value, hud.value]) {
      if (el) mutations.observe(el, { childList: true, subtree: true })
    }
  })
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    resizes?.disconnect()
    mutations?.disconnect()
  })
}
