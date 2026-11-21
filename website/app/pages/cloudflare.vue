<script setup lang="ts">
definePageMeta({
  layout: false,
})

useSeo({
  title: 'LiveThing on Cloudflare: your own realtime cloud',
  description: 'Typed realtime in your own Cloudflare account: rooms, presence and shared documents on Durable Objects, billed at Cloudflare rates. One wrangler deploy.',
  type: 'website',
})

defineOgImage('Home', {
  title: 'Your own realtime cloud, on Cloudflare',
})

const statement = [
  { text: 'Realtime services charge you for' },
  { text: 'every connection, every message, every monthly user and every open document.', accent: true },
  { text: 'The more people use your app, the more you pay just to keep it online. LiveThing gives you the same features as code you own, running on' },
  { text: 'your own Cloudflare account,', accent: true },
  { text: 'at Cloudflare prices.' },
]
</script>

<template>
  <main class="landing-frame">
    <CloudflareHero />
    <CloudflareProof />
    <LandingStatement :parts="statement" />
    <CloudflareStory />
    <CloudflarePlugins />
    <CloudflareDeploy />
    <CloudflareBill />
    <CloudflareOwnership />
    <CloudflareExit />
    <LandingCta>
      <template #title>Own your realtime</template>
      <template #description>
        Rooms, presence and shared documents, typed end to end and running in your Cloudflare account. No realtime vendor between you and your users.
      </template>
    </LandingCta>
  </main>
</template>
