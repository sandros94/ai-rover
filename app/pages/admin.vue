<script setup lang="ts">
import type { AccountView } from '#shared/utils/account'
import type { AdminStatus, Diagnosis } from '#shared/utils/admin'

const route = useRoute()
const { loggedIn } = useUserSession()
/** The not-found an unknown page answers, so the page does not exist to anyone but an admin. */
const notFound = () =>
  createError({
    status: 404,
    statusText: `Page not found: ${route.fullPath}`,
    data: { path: route.fullPath },
    fatal: true,
  })
if (!loggedIn.value) throw notFound()

const { data: status, refresh: refreshStatus } = await useFetch('/api/admin/status', {
  default: (): AdminStatus => ({ admin: false }),
})
/** Whether a mission is active, while another cannot land. */
const missionActive = computed(() => status.value.admin && status.value.missionActive)
/** A signed-in visitor who is no admin: their own identity keys, to add to the allowlist. */
const { data: account } = await useFetch<AccountView>('/api/_auth/account', {
  immediate: !status.value.admin,
})
const identityKeys = computed(
  () => account.value?.identities.map(({ provider, subject }) => `${provider}:${subject}`) ?? [],
)
watch(loggedIn, (signedIn) => {
  if (!signedIn) showError(notFound())
})

const state = reactive({ seed: 'mars', x: 0, y: 0 })
const pending = ref(false)
/** What a landing answers, named here: inferring it from the route exceeds the checker's depth. */
interface Landed {
  missionId: string
  stopId: string
  roundId: string
}
const landed = ref<Landed | null>(null)
const error = ref<{ title: string; message: string } | null>(null)

async function seed() {
  pending.value = true
  error.value = null
  landed.value = null
  try {
    landed.value = await $fetch<Landed>('/api/admin/seed', { method: 'POST', body: state })
    await refreshStatus()
  } catch (caught) {
    error.value = { title: 'Not landed', message: requestErrorOf(caught).message }
  } finally {
    pending.value = false
  }
}

const diagnosing = ref(false)
const diagnosis = ref<Diagnosis | null>(null)

async function diagnose() {
  diagnosing.value = true
  error.value = null
  diagnosis.value = null
  try {
    diagnosis.value = await $fetch<Diagnosis>('/api/admin/diagnose', { method: 'POST' })
  } catch (caught) {
    error.value = { title: 'No diagnostics', message: requestErrorOf(caught).message }
  } finally {
    diagnosing.value = false
  }
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no')
const seconds = (s: number) => `${s.toFixed(1)} s`

/** One line per section, green when everything it checks is in place. */
const sections = computed(() => {
  const found = diagnosis.value
  if (!found) return []
  const { database, locks, blobs, mission, runtime } = found
  const tables = Object.entries(database.tables)
  const states = Object.entries(locks.states)
  return [
    {
      key: 'database',
      label: 'Database',
      ok: database.ok,
      ms: database.ms,
      lines: [
        ...(database.error ? [`Error: ${database.error}`] : []),
        `Migrations: ${database.migrations.length ? database.migrations.join(', ') : 'none'}`,
        `Tables: ${tables.length ? tables.map(([name, n]) => `${name} ${n}`).join(', ') : 'none'}`,
      ],
    },
    {
      key: 'locks',
      label: 'Database sessions',
      ok: locks.ok && locks.stuck.length === 0,
      ms: locks.ms,
      lines: [
        ...(locks.error ? [`Error: ${locks.error}`] : []),
        `Sessions: ${states.length ? states.map(([state, n]) => `${state} ${n}`).join(', ') : 'none'}`,
        `Oldest transaction: ${locks.oldestTransactionS === null ? 'none open' : seconds(locks.oldestTransactionS)}`,
        ...locks.stuck.map(
          (session) =>
            `Stuck: pid ${session.pid}, ${session.state}${session.waitEventType ? `, waiting on ${session.waitEventType}` : ''}, ${seconds(session.ageS)}${session.holdsAdvisoryLock ? ', holds an advisory lock' : ''}`,
        ),
      ],
    },
    {
      key: 'mission',
      label: 'Mission read',
      ok: mission.ok,
      ms: mission.ms,
      lines: [
        `Active mission: ${yesNo(mission.active)}`,
        ...(mission.skipped === 'busy'
          ? ['Tick skipped: another tick holds the mission lock']
          : mission.skipped === 'changed'
            ? ['Tick skipped: the mission moved while it was prepared']
            : []),
        ...(mission.error
          ? [
              `Error: ${mission.error.name}${mission.error.code ? ` (${mission.error.code})` : ''}: ${mission.error.message}`,
              ...(mission.error.at ? [`At: ${mission.error.at}`] : []),
            ]
          : []),
      ],
    },
    {
      key: 'blobs',
      label: 'Blobs',
      ok: blobs.ok,
      ms: blobs.ms,
      lines: [
        ...(blobs.error ? [`Error: ${blobs.error}`] : []),
        `Keys: ${blobs.keys >= 1000 ? '1000 or more' : blobs.keys}`,
      ],
    },
    {
      key: 'runtime',
      label: 'Runtime',
      ok: runtime.hasSessionKey && runtime.hasTypesafeToken && runtime.originsConfigured,
      ms: undefined,
      lines: [
        `Node ${runtime.node}${runtime.region ? `, region ${runtime.region}` : ''}`,
        `Session key: ${yesNo(runtime.hasSessionKey)}`,
        `TypeSafe token: ${yesNo(runtime.hasTypesafeToken)}`,
        `Sign-in origins: ${yesNo(runtime.originsConfigured)}`,
      ],
    },
  ]
})
</script>

<template>
  <UContainer v-if="!status.admin" class="max-w-sm py-16 text-center" data-test="admin-not-found">
    <p class="text-6xl font-semibold">404</p>
    <p class="mt-2 text-muted">Page not found: {{ route.fullPath }}</p>
    <div v-if="identityKeys.length" class="mt-10 space-y-2 text-left" data-test="admin-keys">
      <p class="text-sm text-muted">Your identity keys:</p>
      <ul class="space-y-1">
        <li v-for="key in identityKeys" :key="key">
          <code class="text-sm break-all select-all">{{ key }}</code>
        </li>
      </ul>
    </div>
  </UContainer>
  <UContainer v-else class="max-w-sm py-16">
    <UCard>
      <template #header>
        <h1 class="text-lg font-semibold">Mission control</h1>
      </template>

      <div class="flex flex-col gap-4">
        <UButton
          type="button"
          data-test="admin-diagnose"
          color="neutral"
          variant="outline"
          :loading="diagnosing"
          block
          @click="diagnose"
        >
          Run diagnostics
        </UButton>

        <UForm
          v-if="!missionActive"
          :state="state"
          class="flex flex-col gap-4"
          data-test="admin-seed-form"
          @submit="seed"
        >
          <p class="text-sm text-muted">No mission is active: land one.</p>
          <UFormField label="World seed" name="seed" data-test="admin-seed">
            <UInput v-model="state.seed" autocapitalize="off" class="w-full" />
          </UFormField>
          <UFormField label="Landing x (m)" name="x" data-test="admin-x">
            <UInputNumber v-model="state.x" class="w-full" />
          </UFormField>
          <UFormField label="Landing y (m)" name="y" data-test="admin-y">
            <UInputNumber v-model="state.y" class="w-full" />
          </UFormField>
          <UButton type="submit" :loading="pending" block>Land the mission</UButton>
        </UForm>

        <UAlert
          v-if="landed"
          data-test="admin-result"
          color="success"
          variant="subtle"
          title="Mission landed"
          :description="`Mission ${landed.missionId}, stop ${landed.stopId}, round ${landed.roundId}.`"
        />
        <UAlert
          v-if="error"
          data-test="admin-error"
          color="error"
          variant="subtle"
          :title="error.title"
          :description="error.message"
        />

        <ul v-if="sections.length" class="flex flex-col gap-3 text-sm">
          <li
            v-for="section in sections"
            :key="section.key"
            :data-test="`diagnosis-${section.key}`"
            :data-ok="String(section.ok)"
            class="flex gap-2"
          >
            <UIcon
              :name="section.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
              :class="section.ok ? 'text-success' : 'text-error'"
              class="mt-0.5 size-4 shrink-0"
            />
            <div class="min-w-0">
              <p class="font-medium" :class="section.ok ? 'text-success' : 'text-error'">
                {{ section.label }}
                <span v-if="section.ms !== undefined" class="font-normal text-muted">
                  · {{ section.ms }} ms
                </span>
              </p>
              <p v-for="line in section.lines" :key="line" class="break-words text-muted">
                {{ line }}
              </p>
            </div>
          </li>
        </ul>
      </div>
    </UCard>
  </UContainer>
</template>
