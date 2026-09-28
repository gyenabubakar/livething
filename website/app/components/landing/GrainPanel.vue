<script setup lang="ts">
// A warm gradient with light streaks and film grain, drawn with CSS and an
// SVG noise filter so no image asset is needed.
withDefaults(defineProps<{ tone?: 'ember' | 'dusk' }>(), { tone: 'ember' })
</script>

<template>
  <div class="grain-panel relative overflow-hidden" :class="`grain-${tone}`">
    <div class="grain-streaks absolute inset-0" aria-hidden="true" />
    <svg class="absolute inset-0 size-full mix-blend-overlay opacity-70" aria-hidden="true">
      <filter id="grain-panel-noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain-panel-noise)" />
    </svg>
    <div class="relative size-full">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.grain-ember {
  background:
    radial-gradient(120% 90% at 85% 10%, #ffb36b 0%, transparent 45%),
    radial-gradient(90% 80% at 10% 100%, #7a1d00 0%, transparent 60%),
    linear-gradient(135deg, #2a0a00 0%, #c43d00 45%, #ff7a1a 75%, #ffc690 100%);
}

.grain-dusk {
  background:
    radial-gradient(100% 80% at 90% 0%, #ff8a3d 0%, transparent 50%),
    linear-gradient(160deg, #0c0a09 0%, #3b1204 50%, #a3360a 100%);
}

.grain-streaks {
  background: repeating-linear-gradient(118deg, transparent 0 38px, rgb(255 255 255 / 0.07) 38px 40px, transparent 40px 90px);
  mask-image: linear-gradient(118deg, transparent 10%, black 50%, transparent 90%);
  filter: blur(1.5px);
}
</style>
