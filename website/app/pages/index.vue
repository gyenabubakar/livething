<script setup lang="ts">
definePageMeta({
  colorMode: 'dark',
  layout: false,
})

useHead({
  titleTemplate: '',
  link: [
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

useSeo({
  title:
    page.value?.title
    || 'WSKit — The complete WebSocket stack for TypeScript',
  description:
    page.value?.description
    || 'A typed, batteries-included WebSocket framework for TypeScript. One inferred contract types your client and server: channels, streams, requests, reconnection.',
  type: 'website',
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
