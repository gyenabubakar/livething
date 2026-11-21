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
  { text: 'LiveThing gives you rooms, presence and shared documents as' },
  { text: 'code you own,', accent: true },
  { text: 'typed end to end and running on' },
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
        Rooms, presence and shared documents, typed end to end and running in your Cloudflare account.
      </template>
    </LandingCta>
  </main>
</template>
