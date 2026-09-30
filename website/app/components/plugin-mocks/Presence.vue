<script setup lang="ts">
import { createTimeline } from 'animejs'

// A room's live member list: Yaa joins, and Ben comes back from away. Every
// member sees the same list update.
const members = [
  { name: 'amara', tone: 'bg-orange-400', status: 'online' },
  { name: 'kofi', tone: 'bg-sky-400', status: 'online' },
]
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-join', { maxHeight: [0, 52], opacity: [0, 1], duration: 450 }, 800)
  .add('.m-here-3', { opacity: 0, duration: 150 }, 800)
  .add('.m-here-4', { opacity: [0, 1], duration: 150 }, 800)
  .add('.m-toast', { opacity: [0, 1, 1, 0], translateY: [6, 0, 0, 0], duration: 1800 }, 900)
  .add('.m-back', { opacity: [0, 1], duration: 300 }, 3000)
  .add('.m-away', { opacity: 0, duration: 300 }, 3000)
  .add('.m-ben', { opacity: [0.45, 1], duration: 300 }, 3000)
  .add('.m-scene', { opacity: 0, duration: 400 }, 5600)
  .add(['.m-join', '.m-here-4', '.m-back'], { opacity: 0, duration: 1 }, 6000)
  .add('.m-join', { maxHeight: 0, duration: 1 }, 6000)
  .add(['.m-here-3', '.m-away'], { opacity: 1, duration: 1 }, 6000)
  .add('.m-ben', { opacity: 0.45, duration: 1 }, 6000)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6001))
</script>

<template>
  <div ref="root" class="relative w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene border border-white/10 bg-zinc-950/85 shadow-2xl">
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span class="font-medium text-white"># launch</span>
        <span class="relative h-4 w-14 text-right text-[11px] text-zinc-400">
          <span class="m-here-3 absolute inset-0">3 here</span>
          <span class="m-here-4 rm-show absolute inset-0 opacity-0">4 here</span>
        </span>
      </div>
      <p v-for="member in members" :key="member.name" class="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <span class="flex size-7 items-center justify-center text-[11px] font-semibold text-zinc-950" :class="member.tone">{{ member.name[0]!.toUpperCase() }}</span>
        <span class="flex-1">{{ member.name }}</span>
        <span class="flex items-center gap-1.5 text-[11px] text-zinc-400"><span class="size-1.5 rounded-full bg-emerald-400" /> online</span>
      </p>
      <p class="m-ben flex items-center gap-3 border-b border-white/5 px-4 py-3 opacity-45">
        <span class="flex size-7 items-center justify-center bg-violet-400 text-[11px] font-semibold text-zinc-950">B</span>
        <span class="flex-1">ben</span>
        <span class="relative block h-4 w-16 text-[11px] text-zinc-400">
          <span class="m-away absolute inset-0 flex items-center justify-end gap-1.5"><span class="size-1.5 rounded-full bg-zinc-500" /> away</span>
          <span class="m-back rm-show absolute inset-0 flex items-center justify-end gap-1.5 opacity-0"><span class="size-1.5 rounded-full bg-emerald-400" /> online</span>
        </span>
      </p>
      <div class="m-join rm-show max-h-0 overflow-hidden opacity-0">
        <p class="flex items-center gap-3 bg-orange-500/[0.08] px-4 py-3">
          <span class="flex size-7 items-center justify-center bg-emerald-400 text-[11px] font-semibold text-zinc-950">Y</span>
          <span class="flex-1">yaa</span>
          <span class="flex items-center gap-1.5 text-[11px] text-zinc-400"><span class="size-1.5 rounded-full bg-emerald-400" /> online</span>
        </p>
      </div>
    </div>
    <p class="m-toast absolute -bottom-9 left-1/2 -ml-12 w-24 bg-white/10 py-1 text-center text-[11px] text-orange-50 opacity-0 backdrop-blur">
      yaa joined
    </p>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .max-h-0 {
    max-height: none;
  }

  .m-here-3,
  .m-away {
    opacity: 0;
  }

  .m-ben {
    opacity: 1;
  }
}
</style>
