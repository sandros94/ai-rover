<script setup lang="ts">
import type { PlaybackMode, PlaybackRate } from '#shared/utils/client'
import type { PanelId, PanelSize } from '#shared/utils/client/hud'
import { formatDuration } from '#shared/utils/client/instruments'
import ViewToggle from '~/components/map/ViewToggle.vue'
import type { MapViewMode } from '~/composables/useMapView'
import FloatingPanel from './FloatingPanel.vue'
import HudLayer from './HudLayer.vue'
import PhoneSheet from './PhoneSheet.vue'

/**
 * A page that is its scene: the scene fills the viewport under a slim top bar, the HUD floats
 * over it. On a wide viewport the offered `panels` are windows the visitor opens, drags, resizes
 * and closes, their layout kept per browser; on a phone the instruments and the vote are bottom
 * sheets, hidden until their toggle. Keys: `1` and `2` switch views, `h` shows or hides the
 * instruments, space plays or pauses and `l` goes live when there is playback; a page adds its
 * own through `shortcuts`, listed with the rest.
 *
 * Slots: `title` (the top bar's left end), `scene`, `top` and `bottom` (widgets centred on those
 * edges), and `panel-<id>` for each offered panel's content.
 */
const props = withDefaults(
  defineProps<{
    /** The panels this page has content for, in the menu's order. */
    panels: readonly PanelId[]
    /** The playback shown, for the status and the keys; none when nothing plays. */
    playback?: {
      mode: PlaybackMode
      t: number
      rate: PlaybackRate
      paused: boolean
      /** Whether there is a live edge to go to. */
      live: boolean
    } | null
    /** The page's own keys, registered and listed in the help. */
    shortcuts?: readonly { key: string; label: string; run: () => void }[]
  }>(),
  { playback: null, shortcuts: () => [] },
)

const emit = defineEmits<{ toggle: []; live: [] }>()
const view = defineModel<MapViewMode>('view', { required: true })

/** Kept across pages and stop changes, which remount the HUD; not across visits. */
const hud = useState('jev-rover:hud', () => ({ visible: true, instruments: false, vote: false }))
const wide = useWideViewport()
const panelLayout = usePanelLayout()
const { layout } = panelLayout

/** The 2D map floats only over the scene; over the map it would repeat it. */
const offered = computed(() => props.panels.filter((id) => id !== 'map2d' || view.value === '3d'))
const floating = computed(() => {
  const current = layout.value
  if (!current || !wide.value || !hud.value.visible) return []
  // Drawn in a fixed order, stacked by z: moving a panel's node would drop its pointer capture.
  return offered.value
    .filter((id) => current.panels[id].open)
    .map((id) => ({ id, placement: current.panels[id], z: 10 + current.order.indexOf(id) }))
})
/** Everything but the map and the vote, which have views of their own on a phone. */
const sheetIds = computed(() => props.panels.filter((id) => id !== 'map2d' && id !== 'vote'))
const hasVote = computed(() => props.panels.includes('vote'))

const area = useTemplateRef<HTMLElement>('area')
const bounds = ref<PanelSize>({ width: 0, height: 0 })
function measure(): void {
  const rect = area.value?.getBoundingClientRect()
  if (!rect) return
  bounds.value = { width: rect.width, height: rect.height }
  panelLayout.load(bounds.value)
}
let observer: ResizeObserver | undefined
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && area.value) {
    observer = new ResizeObserver(measure)
    observer.observe(area.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

function toggleInstruments(): void {
  if (wide.value) hud.value.visible = !hud.value.visible
  else hud.value.instruments = !hud.value.instruments
}
const instrumentsShown = computed(() => (wide.value ? hud.value.visible : hud.value.instruments))

function togglePanel(id: PanelId): void {
  if (layout.value?.panels[id].open) panelLayout.close(id)
  else {
    panelLayout.open(id)
    hud.value.visible = true
  }
}

const status = computed(() => {
  const p = props.playback
  if (!p) return null
  if (p.paused) return { label: `Paused ${formatDuration(p.t)}`, color: 'neutral' as const }
  if (p.mode === 'live') return { label: 'Live', color: 'error' as const }
  return { label: `Replay ${formatDuration(p.t)} · ${p.rate}×`, color: 'info' as const }
})

const SHORTCUTS = computed(() => [
  { keys: ['1'], label: '2D map' },
  { keys: ['2'], label: '3D scene' },
  { keys: ['h'], label: 'Show or hide the instruments' },
  { keys: ['space'], label: 'Play or pause' },
  ...(props.playback?.live === false ? [] : [{ keys: ['l'], label: 'Go live' }]),
  ...props.shortcuts.map(({ key, label }) => ({ keys: [key], label })),
])

defineShortcuts(
  computed(() => ({
    '1': () => (view.value = '2d'),
    '2': () => (view.value = '3d'),
    'h': toggleInstruments,
    ...(props.playback ? { ' ': () => emit('toggle') } : {}),
    ...(props.playback?.live ? { l: () => emit('live') } : {}),
    ...Object.fromEntries(props.shortcuts.map(({ key, run }) => [key, run])),
  })),
)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <SiteHeader class="h-12 shrink-0 border-b border-(--ui-border) px-2 sm:px-3">
      <template #title>
        <slot name="title">
          <NuxtLink to="/" class="truncate text-base font-semibold sm:text-lg">Jev Rover</NuxtLink>
        </slot>
      </template>
      <ViewToggle v-model="view" />
      <UBadge
        v-if="status"
        data-test="playback-status"
        class="hidden lg:inline-flex"
        :color="status.color"
        variant="subtle"
        :icon="playback?.mode === 'live' && !playback.paused ? 'i-lucide-radio' : undefined"
        :label="status.label"
      />
      <div class="ml-auto flex items-center gap-0.5">
        <UButton
          data-test="hud-toggle"
          icon="i-lucide-gauge"
          size="sm"
          color="neutral"
          :variant="instrumentsShown ? 'soft' : 'ghost'"
          :aria-pressed="instrumentsShown"
          aria-label="Instruments"
          @click="toggleInstruments"
        >
          <span class="hidden xl:inline">Instruments</span>
        </UButton>
        <UButton
          v-if="hasVote && !wide"
          data-test="vote-toggle"
          icon="i-lucide-vote"
          size="sm"
          color="neutral"
          :variant="hud.vote ? 'soft' : 'ghost'"
          :aria-pressed="hud.vote"
          aria-label="Vote"
          @click="hud.vote = !hud.vote"
        />
        <UPopover v-if="wide">
          <UButton
            data-test="panels-menu"
            icon="i-lucide-app-window"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="Panels"
          />
          <template #content>
            <div class="flex w-56 flex-col p-1" data-test="panels-list">
              <UButton
                v-for="id in panels"
                :key="id"
                :data-test="`panel-toggle-${id}`"
                :icon="PANEL_SPECS[id].icon"
                :trailing-icon="layout?.panels[id].open ? 'i-lucide-check' : undefined"
                :disabled="!offered.includes(id)"
                size="sm"
                color="neutral"
                variant="ghost"
                class="justify-start"
                :ui="{ trailingIcon: 'ms-auto' }"
                @click="togglePanel(id)"
              >
                {{ PANEL_SPECS[id].title }}
              </UButton>
              <USeparator class="my-1" />
              <UButton
                data-test="panels-reset"
                icon="i-lucide-rotate-ccw"
                size="sm"
                color="neutral"
                variant="ghost"
                class="justify-start"
                @click="panelLayout.reset(bounds)"
              >
                Reset the layout
              </UButton>
            </div>
          </template>
        </UPopover>
        <UPopover
          v-if="wide"
          :content="{ onOpenAutoFocus: (event: Event) => event.preventDefault() }"
        >
          <UButton
            data-test="shortcuts"
            icon="i-lucide-keyboard"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="Keyboard shortcuts"
          />
          <template #content>
            <dl
              data-test="shortcuts-help"
              class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 p-3 text-sm"
            >
              <template v-for="s in SHORTCUTS" :key="s.label">
                <dt class="flex gap-1"><UKbd v-for="k in s.keys" :key="k" :value="k" /></dt>
                <dd class="text-muted">{{ s.label }}</dd>
              </template>
            </dl>
          </template>
        </UPopover>
      </div>
    </SiteHeader>
    <main ref="area" class="relative min-h-0 flex-1">
      <div data-test="scene-layer" class="absolute inset-0">
        <slot name="scene" />
      </div>
      <HudLayer>
        <FloatingPanel
          v-for="p in floating"
          :key="p.id"
          :panel-id="p.id"
          :title="PANEL_SPECS[p.id].title"
          :icon="PANEL_SPECS[p.id].icon"
          :rect="p.placement.rect"
          :minimised="p.placement.minimised"
          :bounds="bounds"
          :z="p.z"
          @focus="panelLayout.raise(p.id)"
          @move="panelLayout.move(p.id, $event)"
          @minimise="panelLayout.minimise(p.id, $event)"
          @close="panelLayout.close(p.id)"
        >
          <slot :name="`panel-${p.id}`" />
        </FloatingPanel>
        <template #top>
          <slot name="top" />
        </template>
        <template #bottom>
          <slot name="bottom" />
        </template>
      </HudLayer>
    </main>
    <template v-if="!wide">
      <PhoneSheet
        v-model:open="hud.instruments"
        sheet="instruments"
        title="Instruments"
        :ids="sheetIds"
      >
        <template v-for="id in sheetIds" #[id]>
          <slot :name="`panel-${id}`" />
        </template>
      </PhoneSheet>
      <PhoneSheet
        v-if="hasVote"
        v-model:open="hud.vote"
        sheet="vote"
        title="Next destination"
        :ids="['vote']"
      >
        <template #vote>
          <slot name="panel-vote" />
        </template>
      </PhoneSheet>
    </template>
  </div>
</template>
