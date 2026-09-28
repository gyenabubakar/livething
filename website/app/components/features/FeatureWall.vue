<script setup lang="ts">
defineProps<{ link?: string, linkLabel?: string }>()

const features = [
  { title: 'Typed errors', icon: 'i-ph-warning-octagon-duotone', desc: 'Catch server errors by type on the client' },
  { title: 'Auth on connect', icon: 'i-ph-key-duotone', desc: 'Refuse a connection before it opens' },
  { title: 'Scheduled work', icon: 'i-ph-clock-duotone', desc: 'Run tasks on a timer, no client needed' },
  { title: 'Rate limiting', icon: 'i-ph-gauge-duotone', desc: 'Cap how fast one connection can send' },
  { title: 'Tags', icon: 'i-ph-tag-duotone', desc: 'Reach every connection with one label' },
  { title: 'Plugins', icon: 'i-ph-puzzle-piece-duotone', desc: 'Package your own typed capabilities' },
  { title: 'Durable state', icon: 'i-ph-database-duotone', desc: 'Rooms and streams survive a redeploy' },
  { title: 'Inbox', icon: 'i-ph-tray-duotone', desc: 'Each member gets every message, once' },
  { title: 'Connection quality', icon: 'i-ph-cell-signal-high-duotone', desc: 'Know when the connection gets slow' },
]
</script>

<template>
  <LandingFeatureCell :link :link-label wide>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div class="grid h-full grid-cols-2 sm:grid-cols-3 content-center gap-3 p-6 sm:p-10">
        <div
          v-for="feature in features"
          :key="feature.title"
          class="wl-tile border border-[rgba(128,128,128,0.2)] p-4"
        >
          <UIcon :name="feature.icon" class="size-5 text-primary" />
          <p class="mt-3 text-sm font-medium text-highlighted">
            {{ feature.title }}
          </p>
          <p class="mt-1 text-xs text-muted">
            {{ feature.desc }}
          </p>
        </div>
      </div>
    </template>
  </LandingFeatureCell>
</template>
