<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'theme-color', content: '#171717' },
  ],
  // `scripts/favicon.ts` renders the PNGs from the SVG.
  link: [
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    { rel: 'manifest', href: '/site.webmanifest' },
  ],
  htmlAttrs: {
    lang: 'en',
  },
})

const title = 'AI Rover'
const description =
  'A community-steered autonomous rover on procedurally generated Martian terrain.'

const { siteUrl } = useRuntimeConfig().public
const route = useRoute()

// `scripts/og-image.ts` renders the card.
useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogSiteName: title,
  ogType: 'website',
  ogUrl: () => new URL(route.path, siteUrl).href,
  ogImage: new URL('/og.jpg', siteUrl).href,
  ogImageType: 'image/jpeg',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt:
    'The Perseverance-class rover from behind, driving over its own tracks towards a Martian sunset.',
  twitterCard: 'summary_large_image',
})
</script>

<template>
  <UApp>
    <NuxtPage />
    <SiteCredits />
  </UApp>
</template>
