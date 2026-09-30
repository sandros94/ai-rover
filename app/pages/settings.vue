<script setup lang="ts">
import type { AccountView } from '#shared/utils/account'
import { signInErrorSentence } from '#shared/utils/sign-in'
import GraphicsSettings from '~/components/settings/GraphicsSettings.vue'
import LinkedPlatforms from '~/components/settings/LinkedPlatforms.vue'
import SettingsSection from '~/components/settings/SettingsSection.vue'

/** Graphics for anyone; the account's sections once signed in. */
const route = useRoute()
const session = useUserSession()
const { loggedIn } = session
// During SSR the request fetch does not carry the visitor's cookies on its own.
const { data: account, error } = await useFetch<AccountView>('/api/_auth/account', {
  headers: useRequestHeaders(['cookie']),
  immediate: loggedIn.value,
  watch: false,
})
const offered = await useAuthProviders()

/** Set when a link flow came back with a failure code. */
const failure = computed(() => {
  const code = route.query.error
  return typeof code === 'string' ? signInErrorSentence(code) : ''
})

async function changed(next: AccountView) {
  account.value = next
  // The server re-issued the session with the account's new name and avatar.
  await session.fetch()
}

useSeoMeta({ title: 'Settings · AI Rover' })
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-4">
    <SiteHeader />
    <h1 class="text-base font-semibold">Settings</h1>
    <UAlert
      v-if="failure"
      data-test="link-error"
      color="error"
      variant="subtle"
      title="Not linked"
      :description="failure"
    />
    <SettingsSection
      title="Graphics"
      description="How finely this browser draws the 3D scene. Kept on this device only."
    >
      <GraphicsSettings />
    </SettingsSection>
    <template v-if="loggedIn">
      <UAlert v-if="error" color="neutral" variant="subtle" title="Your account did not load." />
      <SettingsSection
        v-else-if="account"
        title="Linked platforms"
        description="Sign in with any of them. Linking one that already has an account here brings that account's submissions and LGTMs into this one."
      >
        <LinkedPlatforms :account="account" :offered="offered" @changed="changed" />
      </SettingsSection>
    </template>
  </UContainer>
</template>
