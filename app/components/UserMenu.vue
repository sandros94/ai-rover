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
    <span class="text-sm font-medium">{{ user.displayName }}</span>
    <UButton
      icon="i-lucide-log-out"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="Sign out"
      @click="signOut"
    />
  </div>
  <UButton v-else to="/login" icon="i-lucide-log-in" size="sm" variant="soft">Sign in</UButton>
</template>
