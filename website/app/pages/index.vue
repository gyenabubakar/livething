<script setup lang="ts">
definePageMeta({
  colorMode: 'dark',
  layout: false,
})

const siteUrl = useRuntimeConfig().public.siteUrl as string

useHead({
  titleTemplate: '',
  link: [
    { rel: 'canonical', href: `${siteUrl}/` },
    {
      rel: 'preload',
      href: '/fonts/GeistPixel-Line.woff2',
      as: 'font',
      type: 'font/woff2',
      crossorigin: '',
    },
  ],
})

const { data: page } = await useAsyncData('wskit-docs-home', () => {
  return queryCollection('docs').path('/landing').first()
}, {
  getCachedData(key, nuxtApp) {
    return nuxtApp.payload.data[key] ?? nuxtApp.static.data[key]
  },
})

useSeoMeta({
  title:
    page.value?.title
    || 'WSKit — The complete WebSocket stack for TypeScript',
  description:
    page.value?.description
    || 'A typed WebSocket framework for TypeScript. Channels, streams, requests, and reconnection built in, with one inferred contract across your server and client.',
  ogUrl: `${siteUrl}/`,
  twitterSite: '@GyenAbubakar',
  twitterCreator: '@GyenAbubakar',
})

defineOgImage('Home', {
  title: 'The complete WebSocket stack for TypeScript',
})
</script>

<template>
  <main v-if="page">
    <ContentRenderer :value="page" />
  </main>
</template>
