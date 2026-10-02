<script setup lang="ts">
import { createTimeline } from 'animejs'

// A shared canvas: Amara drags a selection around two cards while Kofi
// switches to following Amara, so Kofi's cursor trails Amara's.
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutSine' } })
  .add('.m-amara', { translateX: [0, 30, 30, 170], translateY: [0, 10, 10, 110], duration: 2400 }, 300)
  // The drag: Amara holds at the start corner, then pulls to the far corner.
  .add('.m-box', { opacity: [0, 1], duration: 1 }, 1900)
  .add('.m-box', { width: ['0px', '140px'], height: ['0px', '100px'], duration: 800 }, 1900)
  .add('.m-kofi', { translateX: [0, -30, 10], translateY: [0, -60, -20], duration: 1800 }, 200)
  .add('.m-follow', { opacity: [0, 1], duration: 300 }, 2200)
  .add('.m-kofi', { translateX: -95, translateY: 5, duration: 1000 }, 2600)
  .add('.m-picked', { opacity: [0, 1], duration: 300 }, 2900)
  .add('.m-scene', { opacity: 0, duration: 400 }, 5600)
  .add(['.m-box', '.m-follow', '.m-picked'], { opacity: 0, duration: 1 }, 6000)
  .add('.m-box', { width: '0px', height: '0px', duration: 1 }, 6000)
  .add(['.m-amara', '.m-kofi'], { translateX: 0, translateY: 0, duration: 1 }, 6000)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6001))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[12px] text-zinc-200">
    <div class="m-scene relative h-64 overflow-hidden border border-white/10 bg-zinc-950/85 bg-[radial-gradient(rgb(255_255_255/0.08)_1px,transparent_1px)] bg-size-[16px_16px] shadow-2xl">
      <div class="absolute top-12 left-14 w-28 border border-white/15 bg-zinc-900 p-2">
        <p class="text-[11px] font-medium text-white">Hero copy</p>
        <p class="mt-1 h-1.5 w-20 bg-white/10" />
        <p class="mt-1 h-1.5 w-16 bg-white/10" />
      </div>
      <div class="absolute top-28 left-36 w-24 border border-white/15 bg-amber-200/90 p-2 text-[11px] text-zinc-900">
        ship it Thursday
      </div>
      <div class="absolute top-14 right-6 w-20 border border-white/15 bg-zinc-900 p-2">
        <p class="h-10 bg-sky-500/20" />
      </div>

      <!-- Amara's selection grows from where the drag started -->
      <div class="m-box rm-show absolute top-[42px] left-[46px] border border-orange-400 bg-orange-400/10 opacity-0" style="width: 0; height: 0" />
      <p class="m-picked rm-show absolute bottom-3 left-3 bg-white/10 px-2 py-1 text-[11px] text-zinc-300 opacity-0">
        amara selected 2 items
      </p>

      <span class="m-amara absolute top-[30px] left-[16px]">
        <UIcon name="i-ph-cursor-fill" class="size-5 text-orange-400" />
        <span class="ml-3 bg-orange-400 px-1 text-[10px] text-zinc-950">amara</span>
      </span>
      <span class="m-kofi absolute top-[150px] right-[70px]">
        <UIcon name="i-ph-cursor-fill" class="size-5 text-sky-400" />
        <span class="ml-3 bg-sky-400 px-1 text-[10px] whitespace-nowrap text-zinc-950">kofi<span class="m-follow rm-show opacity-0"> · following amara</span></span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Without motion, show the finished picture: the drag is done and Kofi is following. */
@media (prefers-reduced-motion: reduce) {
  .m-box {
    width: 140px !important;
    height: 100px !important;
  }

  .m-amara {
    transform: translate(170px, 110px);
  }

  .m-kofi {
    transform: translate(-95px, 5px);
  }
}
</style>
