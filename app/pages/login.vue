<script setup lang="ts">
import type { AuthProvider } from '#auth'
import { signInErrorSentence } from '#shared/utils/sign-in'

const route = useRoute()
const { loggedIn } = useUserSession()

const redirect = computed(() =>
  typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
    ? route.query.redirect
    : '/',
)

/** Set when a sign-in route sent the user back with a failure code. */
const failure = computed(() => {
  const code = route.query.error
  return typeof code === 'string' ? signInErrorSentence(code) : ''
})

if (loggedIn.value) await navigateTo(redirect.value)

const providers = await useAuthProviders()
const offers = (provider: AuthProvider) => providers.value.includes(provider)

const handle = ref('')

async function signInWithAtproto() {
  const value = handle.value.trim()
  if (value) {
    await navigateTo(signInUrl('atproto', { redirect: redirect.value, handle: value }), {
      external: true,
    })
  }
}
</script>

<template>
  <UContainer class="max-w-sm py-16">
    <UCard>
      <template #header>
        <h1 class="text-lg font-semibold">Sign in</h1>
      </template>

      <div class="flex flex-col gap-6">
        <UAlert
          v-if="failure"
          data-test="login-error"
          color="error"
          variant="subtle"
          title="Not signed in"
          :description="failure"
        />

        <template v-for="provider in REDIRECT_PROVIDERS" :key="provider">
          <UButton
            v-if="offers(provider)"
            :data-test="`sign-in-${provider}`"
            :to="signInUrl(provider, { redirect })"
            external
            :icon="PROVIDER_DISPLAY[provider].icon"
            color="neutral"
            block
          >
            Continue with {{ PROVIDER_DISPLAY[provider].label }}
          </UButton>
        </template>

        <form
          v-if="offers('atproto')"
          data-test="atproto-sign-in"
          class="flex flex-col gap-2"
          @submit.prevent="signInWithAtproto"
        >
          <UInput
            v-model="handle"
            placeholder="alice.bsky.social"
            autocomplete="username"
            aria-label="AT Protocol handle or DID"
            icon="i-lucide-at-sign"
          />
          <UButton type="submit" :disabled="!handle.trim()" block>
            Continue with AT Protocol
          </UButton>
        </form>

        <p v-if="!providers.length" data-test="no-sign-in" class="text-sm text-muted">
          Sign-in is not available on this address.
        </p>
      </div>
    </UCard>
  </UContainer>
</template>
