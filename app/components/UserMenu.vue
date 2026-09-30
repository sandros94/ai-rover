<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { AdminStatus } from '#shared/utils/admin'

const { loggedIn, user, clear } = useUserSession()

async function signOut() {
  await clear()
  await navigateTo('/')
}

/** Whether the signed-in user may use `/admin`, asked again for each account signed in. */
const { data: adminStatus, execute: askAdmin } = useFetch('/api/admin/status', {
  key: 'admin-status',
  server: false,
  immediate: false,
  default: (): AdminStatus => ({ admin: false }),
})
watch(
  () => user.value?.id,
  (id) => {
    if (id) void askAdmin()
    else adminStatus.value = { admin: false }
  },
  { immediate: true },
)

const items = computed<DropdownMenuItem[]>(() =>
  user.value
    ? [
        { label: 'Profile', icon: 'i-lucide-user', to: `/u/${user.value.id}` },
        { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
        ...(adminStatus.value.admin
          ? [{ label: 'Admin', icon: 'i-lucide-shield', to: '/admin' }]
          : []),
        { type: 'separator' },
        { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut },
      ]
    : [],
)
</script>

<template>
  <UDropdownMenu v-if="loggedIn && user" :items="items" :content="{ align: 'end' }">
    <UButton
      data-test="user-menu"
      color="neutral"
      variant="ghost"
      size="sm"
      class="gap-2"
      :aria-label="`Account menu for ${user.displayName}`"
    >
      <UAvatar :src="user.avatarUrl" :alt="user.displayName" size="sm" />
      <span class="hidden text-sm font-medium sm:inline">{{ user.displayName }}</span>
    </UButton>
  </UDropdownMenu>
  <template v-else>
    <UButton
      to="/settings"
      data-test="visitor-settings"
      icon="i-lucide-settings"
      size="sm"
      color="neutral"
      variant="ghost"
      class="hidden md:inline-flex"
      aria-label="Settings"
    />
    <UButton to="/login" icon="i-lucide-log-in" size="sm" variant="soft" aria-label="Sign in">
      <span class="hidden sm:inline">Sign in</span>
    </UButton>
  </template>
</template>
