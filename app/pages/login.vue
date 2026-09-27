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

/*
 * Which providers exist depends on the address the visitor uses, so the server-side fetch must
 * carry the browser's own host headers rather than the function's internal address.
 */
const { data } = await useFetch('/api/auth/providers', {
  $fetch: useRequestFetch(),
  default: () => ({ providers: [] as AuthProvider[] }),
})
const offers = (provider: AuthProvider) => data.value.providers.includes(provider)

const handle = ref('')

function signInUrl(provider: AuthProvider, extra: Record<string, string> = {}) {
  return `/api/auth/${provider}?${new URLSearchParams({ redirect: redirect.value, ...extra })}`
}

async function signInWithAtproto() {
  const value = handle.value.trim()
  if (value) await navigateTo(signInUrl('atproto', { handle: value }), { external: true })
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

        <UButton
          v-if="offers('github')"
          :to="signInUrl('github')"
          external
          icon="i-lucide-github"
          color="neutral"
          block
        >
          Continue with GitHub
        </UButton>

        <form
          v-if="offers('atproto')"
          class="flex flex-col gap-2"
          @submit.prevent="signInWithAtproto"
        >
          <UInput
            v-model="handle"
            placeholder="alice.bsky.social"
            autocomplete="username"
            aria-label="Bluesky or AT Protocol handle"
            icon="i-lucide-at-sign"
          />
          <UButton type="submit" :disabled="!handle.trim()" block> Continue with Bluesky </UButton>
        </form>

        <p v-if="!data.providers.length" class="text-sm text-muted">
          Sign-in is not available on this address.
        </p>
      </div>
    </UCard>
  </UContainer>
</template>
