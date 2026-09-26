<template>
  <header class="flex flex-wrap items-center gap-3">
    <NuxtLink to="/" class="text-lg font-semibold">Jev Rover</NuxtLink>
    <nav aria-label="Site">
      <UButton
        to="/drives"
        data-test="nav-journey"
        icon="i-lucide-route"
        color="neutral"
        variant="ghost"
        size="sm"
      >
        Journey
      </UButton>
      <UButton
        to="/community"
        data-test="nav-community"
        icon="i-lucide-users"
        color="neutral"
        variant="ghost"
        size="sm"
      >
        Community
      </UButton>
    </nav>
    <div class="ml-auto">
      <UserMenu />
    </div>
  </header>
</template>
