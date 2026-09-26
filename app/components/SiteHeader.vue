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
    </nav>
    <div class="ml-auto">
      <UserMenu />
    </div>
  </header>
</template>
