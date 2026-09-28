<script setup lang="ts">
import type { AuthProvider } from '#auth'
import { AUTH_PROVIDERS } from '#auth'
import type { AccountView } from '#shared/utils/account'

/**
 * The account's identities: link the missing ones (by the sign-in flow, returning here), unlink
 * any but the last, and pick the one that supplies the name and avatar.
 */
const props = defineProps<{ account: AccountView; offered: AuthProvider[] }>()
const emit = defineEmits<{ changed: [account: AccountView] }>()

const pending = ref(false)
const failure = ref('')
const handle = ref('')

const linked = computed(() => new Map(props.account.identities.map((i) => [i.provider, i])))
const rows = computed(() =>
  AUTH_PROVIDERS.filter(
    (provider) => linked.value.has(provider) || props.offered.includes(provider),
  ).map((provider) => ({ provider, identity: linked.value.get(provider) })),
)
const lastOne = computed(() => props.account.identities.length <= 1)

const primaryItems = computed(() =>
  props.account.identities.map((identity) => ({
    value: identity.provider,
    label: `${PROVIDER_DISPLAY[identity.provider].label}: ${identity.handle ?? identity.displayName}`,
  })),
)

function linkUrl(provider: AuthProvider) {
  return signInUrl(provider, { redirect: '/settings', link: true })
}

async function linkAtproto() {
  const value = handle.value.trim()
  if (value) {
    await navigateTo(signInUrl('atproto', { redirect: '/settings', link: true, handle: value }), {
      external: true,
    })
  }
}

async function change(request: () => Promise<AccountView>) {
  pending.value = true
  failure.value = ''
  try {
    emit('changed', await request())
  } catch (error) {
    const data = (error as { data?: { message?: unknown } }).data
    failure.value = typeof data?.message === 'string' ? data.message : 'The change did not save.'
  } finally {
    pending.value = false
  }
}

function unlink(provider: AuthProvider) {
  return change(() =>
    $fetch<AccountView>(`/api/_auth/identities/${provider}`, { method: 'DELETE' }),
  )
}

function choosePrimary(provider: AuthProvider) {
  if (provider === props.account.primaryProvider) return
  return change(() =>
    $fetch<AccountView>('/api/_auth/account', {
      method: 'PATCH',
      body: { primaryProvider: provider },
    }),
  )
}
</script>

<template>
  <div class="space-y-4">
    <UAlert
      v-if="failure"
      data-test="settings-error"
      color="error"
      variant="subtle"
      :description="failure"
    />
    <ul class="divide-y divide-(--ui-border) rounded-lg border border-default">
      <li
        v-for="{ provider, identity } in rows"
        :key="provider"
        :data-test="`platform-${provider}`"
        class="flex flex-wrap items-center gap-3 px-3 py-2"
      >
        <UIcon :name="PROVIDER_DISPLAY[provider].icon" class="size-5 shrink-0" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ PROVIDER_DISPLAY[provider].label }}</p>
          <p v-if="identity" class="truncate text-xs text-muted">
            {{ identity.handle ?? identity.displayName }}
          </p>
        </div>
        <UButton
          v-if="identity"
          data-test="unlink"
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="lastOne || pending"
          :title="lastOne ? 'The only way into this account; link another first.' : undefined"
          @click="unlink(provider)"
        >
          Unlink
        </UButton>
        <form
          v-else-if="provider === 'atproto'"
          data-test="link-atproto"
          class="flex w-full gap-2 sm:w-auto"
          @submit.prevent="linkAtproto"
        >
          <UInput
            v-model="handle"
            size="sm"
            placeholder="alice.bsky.social"
            aria-label="AT Protocol handle or DID"
            class="min-w-0 flex-1"
          />
          <UButton type="submit" size="sm" :disabled="!handle.trim()">Link</UButton>
        </form>
        <UButton v-else data-test="link" :to="linkUrl(provider)" external size="sm"> Link </UButton>
      </li>
    </ul>

    <UFormField
      v-if="primaryItems.length > 1"
      label="Name and avatar from"
      help="What your submissions and profile show."
    >
      <URadioGroup
        data-test="primary"
        :model-value="account.primaryProvider ?? undefined"
        :items="primaryItems"
        :disabled="pending"
        @update:model-value="(value) => choosePrimary(value as AuthProvider)"
      />
    </UFormField>
  </div>
</template>
