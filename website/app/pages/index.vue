<script setup lang="ts">
definePageMeta({
  layout: false,
})

useHead({
  titleTemplate: '',
})

const { data: page } = await useAsyncData('livething-docs-home', () => {
  return queryCollection('docs').path('/landing').first()
}, {
  getCachedData(key, nuxtApp) {
    return nuxtApp.payload.data[key] ?? nuxtApp.static.data[key]
  },
})

useSeo({
  title:
    page.value?.title
    || 'LiveThing — The complete WebSocket stack for TypeScript',
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
  <main v-if="page" class="landing-frame">
    <ContentRenderer :value="page" />
  </main>
</template>
