<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
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
 * sheets, hidden until their toggle. One menu lists the windows: all of them at once, each on
 * its own, and the layout's reset. Keys: `1` and `2` switch views, `h` shows or hides every
 * window (the instruments' sheet on a phone), space plays or pauses and `l` goes live when there
 * is playback; a page adds its own through `shortcuts`, listed with the rest.
 *
 * Slots: `title` (the top bar's left end), `status` (beside the view switch), `scene`, `top` and
 * `bottom` (widgets centred on those edges), and `panel-<id>` for each offered panel's content.
 * With a `detail`, `panel-details` shows as its own window (a sheet on a phone) until closed,
 * which emits `closeDetail`.
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
    /** A focused object's details to show, titled; none without a focus. */
    detail?: { key: string; title: string } | null
  }>(),
  { playback: null, shortcuts: () => [], detail: null },
)

const emit = defineEmits<{ toggle: []; live: []; closeDetail: [] }>()
const view = defineModel<MapViewMode>('view', { required: true })

/** Kept across pages and stop changes, which remount the HUD; not across visits. */
const hud = useState('ai-rover:hud', () => ({ visible: true, instruments: false, vote: false }))
const wide = useWideViewport()
const panelLayout = usePanelLayout()
const { layout } = panelLayout

/** The 2D map floats only over the scene; over the map it would repeat it. */
const offered = computed(() => props.panels.filter((id) => id !== 'map2d' || view.value === '3d'))
const floating = computed(() => {
  const current = layout.value
  if (!current || !wide.value) return []
  // A focused object's details show even with the HUD hidden: the visitor asked for them.
  const shown: PanelId[] = [
    ...(hud.value.visible ? offered.value.filter((id) => current.panels[id].open) : []),
    ...(props.detail ? (['details'] as const) : []),
  ]
  // Drawn in a fixed order, stacked by z: moving a panel's node would drop its pointer capture.
  return shown.map((id) => ({
    id,
    placement: current.panels[id],
    z: 10 + current.order.indexOf(id),
    title: id === 'details' && props.detail ? props.detail.title : PANEL_SPECS[id].title,
  }))
})
// A newly focused object's details come to the front.
watch(
  () => props.detail?.key,
  (key) => {
    if (key && layout.value) panelLayout.raise('details')
  },
)
const detailSheet = computed({
  get: () => props.detail !== null,
  set: (open) => {
    if (!open) emit('closeDetail')
  },
})
function closePanel(id: PanelId): void {
  if (id === 'details') emit('closeDetail')
  else panelLayout.close(id)
}
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
const sceneLayer = useTemplateRef<HTMLElement>('sceneLayer')
useCreditsLift(sceneLayer, area)

/** Every window at once on a wide viewport; the instruments' sheet on a phone. */
function toggleInstruments(): void {
  if (wide.value) hud.value.visible = !hud.value.visible
  else hud.value.instruments = !hud.value.instruments
}

function togglePanel(id: PanelId): void {
  if (layout.value?.panels[id].open) panelLayout.close(id)
  else {
    panelLayout.open(id)
    hud.value.visible = true
  }
}

/** Checkable items keep the menu open, so several windows can be toggled in one visit. */
const keepOpen = (event: Event) => event.preventDefault()
const windowsMenu = computed<DropdownMenuItem[][]>(() => [
  [
    {
      type: 'checkbox',
      label: hud.value.visible ? 'All windows shown' : 'All windows hidden',
      icon: 'i-lucide-layers',
      checked: hud.value.visible,
      kbds: ['h'],
      onSelect: keepOpen,
      onUpdateChecked: toggleInstruments,
    },
  ],
  props.panels.map((id) => ({
    type: 'checkbox' as const,
    label: PANEL_SPECS[id].title,
    icon: PANEL_SPECS[id].icon,
    checked: layout.value?.panels[id].open ?? false,
    disabled: !offered.value.includes(id),
    onSelect: keepOpen,
    onUpdateChecked: () => togglePanel(id),
  })),
  [
    {
      'label': 'Reset the layout',
      'icon': 'i-lucide-rotate-ccw',
      'data-test': 'panels-reset',
      'onSelect': () => panelLayout.reset(bounds.value),
    },
  ],
])

const status = computed(() => {
  const p = props.playback
  if (!p) return null
  if (p.paused) return { label: 'Paused', time: formatDuration(p.t), color: 'neutral' as const }
  if (p.mode === 'live') return { label: 'Live', color: 'error' as const }
  return {
    label: 'Replay',
    time: formatDuration(p.t),
    rate: `${p.rate}×`,
    color: 'info' as const,
  }
})

const SHORTCUTS = computed(() => [
  { keys: ['1'], label: '2D map' },
  { keys: ['2'], label: '3D scene' },
  { keys: ['h'], label: 'Show or hide all windows' },
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
          <NuxtLink to="/" class="truncate text-base font-semibold sm:text-lg">AI Rover</NuxtLink>
        </slot>
      </template>
      <ViewToggle v-model="view" />
      <slot name="status" />
      <UBadge
        v-if="status"
        data-test="playback-status"
        class="hidden lg:inline-flex"
        :color="status.color"
        variant="subtle"
        :icon="playback?.mode === 'live' && !playback.paused ? 'i-lucide-radio' : undefined"
      >
        {{ status.label }}
        <span v-if="status.time" class="readout min-w-[8ch]">{{ status.time }}</span>
        <template v-if="status.rate"> · {{ status.rate }}</template>
      </UBadge>
      <div class="ml-auto flex items-center gap-0.5">
        <UButton
          v-if="!wide"
          data-test="hud-toggle"
          icon="i-lucide-gauge"
          size="sm"
          color="neutral"
          :variant="hud.instruments ? 'soft' : 'ghost'"
          :aria-pressed="hud.instruments"
          aria-label="Instruments"
          @click="toggleInstruments"
        />
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
        <UDropdownMenu v-if="wide" :items="windowsMenu" :content="{ align: 'end' }">
          <UButton
            data-test="windows-menu"
            icon="i-lucide-app-window"
            size="sm"
            color="neutral"
            :variant="hud.visible ? 'soft' : 'ghost'"
            aria-label="Windows"
          >
            <span class="hidden xl:inline">Windows</span>
          </UButton>
        </UDropdownMenu>
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
      <div ref="sceneLayer" data-test="scene-layer" class="absolute inset-0">
        <slot name="scene" />
      </div>
      <HudLayer>
        <FloatingPanel
          v-for="p in floating"
          :key="p.id"
          :panel-id="p.id"
          :title="p.title"
          :icon="PANEL_SPECS[p.id].icon"
          :rect="p.placement.rect"
          :minimised="p.placement.minimised"
          :bounds="bounds"
          :z="p.z"
          @focus="panelLayout.raise(p.id)"
          @move="panelLayout.move(p.id, $event)"
          @minimise="panelLayout.minimise(p.id, $event)"
          @close="closePanel(p.id)"
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
        v-if="detail"
        v-model:open="detailSheet"
        sheet="details"
        :title="detail.title"
        :ids="['details']"
      >
        <template #details>
          <slot name="panel-details" />
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
