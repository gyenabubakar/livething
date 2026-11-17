<script setup lang="ts">
// The frame of every Split Stream illustration: the picture on the landing page's grid, its
// caption, and for a moving picture a button that stops the motion (WCAG 2.2.2: motion over
// 5 seconds needs a pause).
defineProps<{ caption?: string; animated?: boolean }>()

// A picture that moves with JavaScript binds this, and passes it to its timeline.
const paused = defineModel<boolean>('paused', { default: false })
</script>

<template>
  <figure class="ss-figure not-prose my-8 border border-default bg-(--ui-bg)" :class="{ 'ss-paused': paused }">
    <div class="relative overflow-hidden">
      <div class="absolute inset-0 bg-[linear-gradient(var(--art-grid)_1px,transparent_1px),linear-gradient(90deg,var(--art-grid)_1px,transparent_1px)] bg-size-[16px_16px]" aria-hidden="true" />
      <div class="absolute inset-0 bg-[radial-gradient(55%_60%_at_50%_50%,rgb(244_97_15/0.08),transparent)]" aria-hidden="true" />
      <!-- On a phone a picture keeps a readable size and scrolls sideways in its frame. -->
      <div class="ss-scroll relative overflow-x-auto p-4 sm:p-6">
        <slot />
      </div>
    </div>
    <figcaption v-if="caption || animated" class="flex items-start gap-3 border-t border-default px-4 py-3 text-sm/6 text-muted">
      <span v-if="caption" class="flex-1">{{ caption }}</span>
      <button
        v-if="animated"
        type="button"
        class="ss-pause flex shrink-0 items-center gap-1.5 border border-default px-2 py-1 font-mono text-xs text-toned hover:border-primary/60 hover:text-highlighted"
        :aria-pressed="paused"
        @click="paused = !paused"
      >
        <UIcon :name="paused ? 'i-ph-play-fill' : 'i-ph-pause-fill'" class="size-3" aria-hidden="true" />
        {{ paused ? 'play' : 'pause' }}
      </button>
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

/* Packets glow like the landing page's: orange going down, sky going up. */
.ss-glow-down {
  filter: drop-shadow(0 0 5px #ff8a3d);
}

.ss-glow-up {
  filter: drop-shadow(0 0 5px #38bdf8);
}

/* With reduced motion the pictures do not move, so there is nothing to pause. */
@media (prefers-reduced-motion: reduce) {
  .ss-pause {
    display: none;
  }
}
</style>
