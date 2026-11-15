<script setup lang="ts">
// The frame of every Split Stream illustration: the picture, its caption, and for a moving
// picture a button that stops the motion (WCAG 2.2.2: motion over 5 seconds needs a pause).
defineProps<{ caption?: string; animated?: boolean }>()

// A picture that moves with JavaScript, not CSS, binds this to stop too.
const paused = defineModel<boolean>('paused', { default: false })
</script>

<template>
  <figure class="ss-figure not-prose my-6 overflow-hidden rounded-lg border border-default bg-(--art-top)" :class="{ 'ss-paused': paused }">
    <!-- On a phone a picture keeps a readable size and scrolls sideways in its frame. -->
    <div class="ss-scroll overflow-x-auto p-3 sm:p-5">
      <slot />
    </div>
    <figcaption v-if="caption || animated" class="flex items-start gap-3 border-t border-default px-4 py-2.5 text-sm text-muted">
      <span v-if="caption" class="flex-1">{{ caption }}</span>
      <UButton
        v-if="animated"
        class="ss-pause shrink-0"
        size="xs"
        color="neutral"
        variant="subtle"
        :icon="paused ? 'i-ph-play-fill' : 'i-ph-pause-fill'"
        :label="paused ? 'Play' : 'Pause'"
        @click="paused = !paused"
      />
    </figcaption>
  </figure>
</template>

<style>
.ss-paused *,
.ss-paused *::before,
.ss-paused *::after {
  animation-play-state: paused !important;
}

.ss-scroll svg[role='img'] {
  min-width: 560px;
}

.ss-scroll svg[role='img'].ss-narrow {
  min-width: 440px;
}

/* With reduced motion the pictures do not move, so there is nothing to pause. */
@media (prefers-reduced-motion: reduce) {
  .ss-pause {
    display: none;
  }
}
</style>
