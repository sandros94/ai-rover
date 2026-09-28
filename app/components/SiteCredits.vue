<script setup lang="ts">
/**
 * The source and host credit, fixed to the lower-left corner of every page. It stacks under the
 * HUD's panels and sheets, and rises by `--credits-lift` over widgets a page keeps in that corner.
 */
/**
 * In development the DevTools dock's collapsed bar reaches 36 px up the foot, at a place that
 * scales with the viewport's width, so the credit rises over it instead.
 */
const bottom = import.meta.dev
  ? 'bottom-[calc(0.5rem+max(var(--credits-lift,0px),2.25rem))]'
  : 'bottom-[calc(0.5rem+var(--credits-lift,0px))]'
</script>

<template>
  <aside
    data-site-credits
    aria-label="Credits"
    :class="[
      'fixed left-2 z-[5] flex h-6 items-center gap-1.5 opacity-70 transition-opacity focus-within:opacity-100 hover:opacity-100',
      bottom,
    ]"
  >
    <a
      data-test="credit-source"
      href="https://github.com/sandros94/ai-rover"
      target="_blank"
      rel="noopener"
      aria-label="Source on GitHub"
      class="flex size-6 items-center justify-center rounded bg-(--ui-bg)/75 text-muted backdrop-blur-sm hover:text-highlighted"
    >
      <UIcon name="i-lucide-github" class="size-4" />
    </a>
    <a
      data-test="credit-host"
      href="https://www.netlify.com"
      target="_blank"
      rel="noopener"
      class="flex h-6 items-center"
    >
      <img
        src="https://www.netlify.com/img/global/badges/netlify-color-accent.svg"
        alt="Deploys by Netlify"
        class="h-6 w-auto rounded"
      />
    </a>
  </aside>
</template>
