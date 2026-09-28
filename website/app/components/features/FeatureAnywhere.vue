<script setup lang="ts">
defineProps<{ link?: string, linkLabel?: string }>()
</script>

<template>
  <LandingFeatureCell :link :link-label wide>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <LandingEngineFlowIllustration class="absolute inset-0 px-4 py-8" />
    </template>
  </LandingFeatureCell>
</template>
