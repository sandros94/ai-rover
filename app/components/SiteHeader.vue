<script setup lang="ts">
/**
 * The site's top bar: the title (or the page's own, in the `title` slot), the page's tools in
 * the default slot, the journey and community links (in a menu on phones) and the user menu.
 */
const LINKS = [
  { label: 'Journey', to: '/drives', icon: 'i-lucide-route', test: 'nav-journey' },
  { label: 'Community', to: '/community', icon: 'i-lucide-users', test: 'nav-community' },
]
const menu = LINKS.map(({ label, to, icon }) => ({ label, to, icon }))
</script>

<template>
  <header class="flex min-w-0 items-center gap-2 sm:gap-3">
    <div class="flex min-w-0 shrink items-center gap-1">
      <slot name="title">
        <NuxtLink to="/" class="truncate text-base font-semibold sm:text-lg">Jev Rover</NuxtLink>
      </slot>
    </div>
    <div class="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
      <slot />
    </div>
    <nav aria-label="Site" class="hidden items-center md:flex">
      <UButton
        v-for="link in LINKS"
        :key="link.to"
        :to="link.to"
        :data-test="link.test"
        :icon="link.icon"
        color="neutral"
        variant="ghost"
        size="sm"
      >
        {{ link.label }}
      </UButton>
    </nav>
    <UDropdownMenu :items="menu" class="md:hidden">
      <UButton
        data-test="nav-menu"
        icon="i-lucide-menu"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Site menu"
      />
    </UDropdownMenu>
    <UserMenu />
  </header>
</template>
