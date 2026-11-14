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
    || 'LiveThing — WebSocket-first realtime for TypeScript',
  description:
    page.value?.description
    || 'A typed, WebSocket-first realtime framework for TypeScript. One inferred contract types your client and server: channels, streams, requests, reconnection.',
  type: 'website',
})

defineOgImage('Home', {
  title: 'WebSocket-first realtime for TypeScript',
})
</script>

<template>
  <main v-if="page" class="landing-frame">
    <ContentRenderer :value="page" />
  </main>
</template>
