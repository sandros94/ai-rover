<script setup lang="ts">
import type { Diagnosis } from '#shared/utils/admin'

const { data: status } = await useFetch('/api/admin/status', {
  default: () => ({ configured: false }),
})

const state = reactive({ token: '', seed: 'mars', x: 0, y: 0 })
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
  } catch (caught) {
    error.value = { title: 'Not seeded', message: requestErrorOf(caught).message }
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
    diagnosis.value = await $fetch<Diagnosis>('/api/admin/diagnose', {
      method: 'POST',
      body: { token: state.token },
    })
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
            : mission.skipped === 'deferred'
              ? ['Tick deferred: its time budget ran out; the next read resumes it']
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
  <UContainer class="max-w-sm py-16">
    <UCard>
      <template #header>
        <h1 class="text-lg font-semibold">Mission control</h1>
      </template>

      <p v-if="!status.configured" data-test="admin-unconfigured" class="text-sm text-muted">
        Administration is not configured on this server.
      </p>

      <UForm v-else :state="state" class="flex flex-col gap-4" @submit="seed">
        <UFormField label="Admin token" name="token" required data-test="admin-token">
          <UInput
            v-model="state.token"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>
        <UFormField label="World seed" name="seed" data-test="admin-seed">
          <UInput v-model="state.seed" autocapitalize="off" class="w-full" />
        </UFormField>
        <UFormField label="Landing x (m)" name="x" data-test="admin-x">
          <UInputNumber v-model="state.x" class="w-full" />
        </UFormField>
        <UFormField label="Landing y (m)" name="y" data-test="admin-y">
          <UInputNumber v-model="state.y" class="w-full" />
        </UFormField>

        <div class="flex gap-2">
          <UButton type="submit" :loading="pending" :disabled="!state.token" class="flex-1" block>
            Seed the mission
          </UButton>
          <UButton
            type="button"
            data-test="admin-diagnose"
            color="neutral"
            variant="outline"
            :loading="diagnosing"
            :disabled="!state.token"
            @click="diagnose"
          >
            Run diagnostics
          </UButton>
        </div>

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
      </UForm>
    </UCard>
  </UContainer>
</template>
