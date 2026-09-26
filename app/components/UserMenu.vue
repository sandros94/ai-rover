<script setup lang="ts">
const { loggedIn, user, clear } = useUserSession()

async function signOut() {
  await clear()
  await navigateTo('/')
}
</script>

<template>
  <div v-if="loggedIn && user" class="flex items-center gap-2">
    <UAvatar :src="user.avatarUrl" :alt="user.displayName" size="sm" />
    <span class="hidden text-sm font-medium sm:inline">{{ user.displayName }}</span>
    <UButton
      icon="i-lucide-log-out"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="Sign out"
      @click="signOut"
    />
  </div>
  <UButton v-else to="/login" icon="i-lucide-log-in" size="sm" variant="soft" aria-label="Sign in">
    <span class="hidden sm:inline">Sign in</span>
  </UButton>
</template>
