<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { loggedIn, user, clear } = useUserSession()

async function signOut() {
  await clear()
  await navigateTo('/')
}

const items = computed<DropdownMenuItem[]>(() =>
  user.value
    ? [
        { label: 'Profile', icon: 'i-lucide-user', to: `/u/${user.value.id}` },
        { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
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
  <UButton v-else to="/login" icon="i-lucide-log-in" size="sm" variant="soft" aria-label="Sign in">
    <span class="hidden sm:inline">Sign in</span>
  </UButton>
</template>
