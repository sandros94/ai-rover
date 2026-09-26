<script setup lang="ts">
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
const error = ref('')

async function seed() {
  pending.value = true
  error.value = ''
  landed.value = null
  try {
    landed.value = await $fetch<Landed>('/api/admin/seed', { method: 'POST', body: state })
  } catch (caught) {
    error.value = requestErrorOf(caught).message
  } finally {
    pending.value = false
  }
}
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

        <UButton type="submit" :loading="pending" :disabled="!state.token" block>
          Seed the mission
        </UButton>

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
          title="Not seeded"
          :description="error"
        />
      </UForm>
    </UCard>
  </UContainer>
</template>
