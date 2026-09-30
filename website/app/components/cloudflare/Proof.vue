<script setup lang="ts">
// Figures from Cloudflare's network page and Durable Objects docs (September 2026).
const facts = [
  { value: '348', unit: 'cities', note: 'Each room starts in the data centre closest to the first person who opens it.' },
  { value: '50', unit: 'ms', note: 'From 95% of the world\'s internet users to the nearest Cloudflare data centre.' },
  { value: '32k', unit: 'sockets', note: 'Open WebSockets a single room can hold while it hibernates.' },
  { value: '10', unit: 'GB', note: 'Of SQLite storage inside every room, next to its sockets.' },
]
</script>

<template>
  <section class="frame-row grid grid-cols-2 lg:grid-cols-4">
    <div
      v-for="(fact, index) in facts"
      :key="fact.unit"
      class="border-default px-6 sm:px-10 py-10"
      :class="[index % 2 === 0 && 'border-r', index < 2 && 'max-lg:border-b', index === 1 && 'lg:border-r', index === 2 && 'lg:border-r']"
    >
      <p class="font-serif text-5xl font-semibold tracking-tight text-highlighted">
        {{ fact.value }}<span class="ml-1 font-sans text-base font-medium text-primary">{{ fact.unit }}</span>
      </p>
      <p class="mt-3 max-w-60 text-sm/6 text-muted">
        {{ fact.note }}
      </p>
    </div>
  </section>
</template>
