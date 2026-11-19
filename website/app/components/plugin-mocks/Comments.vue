<script setup lang="ts">
import { createTimeline } from 'animejs'

// A thread on a shared file: Kofi replies with a mention, Amara reacts, and the
// thread is resolved for everyone.
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-reply', { maxHeight: [0, 80], opacity: [0, 1], duration: 450 }, 800)
  .add('.m-reaction', { opacity: [0, 1], scale: [0.6, 1], duration: 300, ease: 'outBack' }, 2200)
  .add('.m-open', { opacity: 0, duration: 200 }, 3600)
  .add('.m-resolved', { opacity: [0, 1], duration: 300 }, 3600)
  .add('.m-thread', { opacity: 0.55, duration: 300 }, 3600)
  .add('.m-scene', { opacity: 0, duration: 400 }, 6000)
  .add(['.m-reply', '.m-reaction', '.m-resolved'], { opacity: 0, duration: 1 }, 6400)
  .add('.m-reply', { maxHeight: 0, duration: 1 }, 6400)
  .add(['.m-open', '.m-thread'], { opacity: 1, duration: 1 }, 6400)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6401))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene border border-white/10 bg-zinc-950/85 shadow-2xl">
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span class="flex items-center gap-2 font-medium text-white"><UIcon name="i-ph-image-duotone" class="size-4 text-zinc-400" /> homepage-hero.png</span>
        <span class="relative h-5 w-20 text-[11px]">
          <span class="m-open absolute inset-0 flex items-center justify-center bg-white/10 text-zinc-300">1 open</span>
          <span class="m-resolved rm-show absolute inset-0 flex items-center justify-center gap-1 bg-emerald-500 text-zinc-950 opacity-0">
            <UIcon name="i-ph-check-bold" class="size-3" /> resolved
          </span>
        </span>
      </div>
      <div class="m-thread space-y-3 px-4 py-4">
        <div class="flex gap-2.5">
          <span class="flex size-6 shrink-0 items-center justify-center bg-orange-400 text-[11px] font-semibold text-zinc-950">A</span>
          <p class="leading-5">
            <span class="font-medium text-white">amara</span>
            <span class="text-zinc-500"> · 2m</span><br>
            The headline wraps on small screens.
          </p>
        </div>
        <div class="m-reply rm-show max-h-0 overflow-hidden opacity-0">
          <div class="flex gap-2.5 border-l border-white/10 pl-3">
            <span class="flex size-6 shrink-0 items-center justify-center bg-sky-400 text-[11px] font-semibold text-zinc-950">K</span>
            <p class="leading-5">
              <span class="font-medium text-white">kofi</span>
              <span class="text-zinc-500"> · now</span><br>
              <span class="text-sky-300">@amara</span> fixed, it fits now.
              <span class="m-reaction rm-show ml-1 inline-flex items-center gap-1 border border-white/10 px-1.5 text-[11px] opacity-0">👍 1</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* With reduced motion, show the end of the story: the reply, the reaction, and the resolved thread. */
@media (prefers-reduced-motion: reduce) {
  .max-h-0 {
    max-height: none;
  }

  .m-open {
    opacity: 0;
  }
}
</style>
