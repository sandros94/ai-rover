<script setup lang="ts">
import { ref } from 'vue'
import { useUserSession } from '#imports'

const TOOLS = [
  {
    title: 'Database',
    description: 'Status, migrate, reset, seed',
    to: '/__rover/db',
    external: true,
  },
  {
    title: 'Disk viewer',
    description: 'Stop disk relief, masks and reachability',
    to: '/_dev/disk',
  },
  {
    title: 'Playground',
    description: 'Instruments and scenes over fixture drives',
    to: '/_dev/playground',
  },
]

const { user, fetch: refreshSession } = useUserSession()
const handle = ref('')
const error = ref<string | null>(null)
const pending = ref(false)

async function signIn(): Promise<void> {
  pending.value = true
  error.value = null
  try {
    await $fetch('/api/_dev/login', { method: 'POST', body: { handle: handle.value.trim() } })
    await refreshSession()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UContainer class="max-w-2xl py-10 space-y-8">
    <h1 class="text-xl font-semibold">Development</h1>

    <ul class="grid gap-3 sm:grid-cols-3">
      <li v-for="tool in TOOLS" :key="tool.to">
        <UCard :ui="{ body: 'p-4' }" class="h-full">
          <ULink :to="tool.to" :external="tool.external" class="font-medium">{{
            tool.title
          }}</ULink>
          <p class="text-sm text-muted">{{ tool.description }}</p>
        </UCard>
      </li>
    </ul>

    <UCard>
      <template #header>
        <h2 class="font-medium">Sign in as…</h2>
      </template>
      <form class="flex items-end gap-2" @submit.prevent="signIn">
        <UFormField label="Handle" help="Becomes dev:<handle>; a-z, 0-9 and dashes.">
          <UInput v-model="handle" placeholder="ada" />
        </UFormField>
        <UButton type="submit" :loading="pending" :disabled="!handle.trim()">Sign in</UButton>
      </form>
      <UAlert v-if="error" class="mt-4" color="error" :title="error" />
      <pre class="mt-4 text-xs font-mono">{{ user ?? 'Signed out' }}</pre>
    </UCard>
  </UContainer>
</template>
