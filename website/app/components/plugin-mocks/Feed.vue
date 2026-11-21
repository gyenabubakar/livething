<script setup lang="ts">
import { createTimeline } from 'animejs'

// An in-app inbox: a new notification lands and the unread count goes up,
// then reading it on one device clears it on every device.
const items = [
  { text: 'ama invited you to #design', time: '5m' },
  { text: 'ben reacted 🎉 to your message', time: '1h' },
]
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-new', { maxHeight: [0, 60], opacity: [0, 1], duration: 450 }, 700)
  .add('.m-count-2', { opacity: 0, duration: 150 }, 700)
  .add('.m-count-3', { opacity: [0, 1], scale: [1.4, 1], duration: 300 }, 700)
  .add('.m-dot', { opacity: 0, duration: 300 }, 2800)
  .add('.m-count-3', { opacity: 0, duration: 200 }, 2800)
  .add('.m-count-0', { opacity: [0, 1], duration: 200 }, 2800)
  .add('.m-devices', { opacity: [0, 1], translateY: [6, 0], duration: 350 }, 3000)
  .add('.m-scene', { opacity: 0, duration: 400 }, 5800)
  .add(['.m-new', '.m-devices', '.m-count-0'], { opacity: 0, duration: 1 }, 6200)
  .add('.m-new', { maxHeight: 0, duration: 1 }, 6200)
  .add(['.m-dot', '.m-count-2'], { opacity: 1, duration: 1 }, 6200)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6201))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene border border-white/10 bg-zinc-950/85 shadow-2xl">
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span class="flex items-center gap-2 font-medium text-white"><UIcon name="i-ph-tray-duotone" class="size-4 text-zinc-400" /> Inbox</span>
        <span class="relative h-5 w-14 text-[11px]">
          <span class="m-count-2 absolute inset-0 flex items-center justify-center bg-orange-500 text-zinc-950">2 new</span>
          <span class="m-count-3 absolute inset-0 flex items-center justify-center bg-orange-500 text-zinc-950 opacity-0">3 new</span>
          <span class="m-count-0 rm-show absolute inset-0 flex items-center justify-center bg-white/10 text-zinc-300 opacity-0">all read</span>
        </span>
      </div>
      <div class="m-new rm-show max-h-0 overflow-hidden opacity-0">
        <p class="flex items-center gap-3 border-b border-white/5 bg-orange-500/[0.08] px-4 py-3">
          <span class="m-dot size-1.5 shrink-0 rounded-full bg-orange-400" />
          <span class="flex-1">kofi replied to your comment</span>
          <span class="text-[11px] text-zinc-500">now</span>
        </p>
      </div>
      <p v-for="item in items" :key="item.text" class="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0">
        <span class="m-dot size-1.5 shrink-0 rounded-full bg-orange-400" />
        <span class="flex-1">{{ item.text }}</span>
        <span class="text-[11px] text-zinc-500">{{ item.time }}</span>
      </p>
    </div>
    <p class="m-devices rm-show mt-3 flex items-center justify-center gap-2 text-[11px] text-orange-50/90 opacity-0">
      <UIcon name="i-ph-device-mobile-duotone" class="size-4" />
      <UIcon name="i-ph-laptop-duotone" class="size-4" />
      <UIcon name="i-ph-device-tablet-duotone" class="size-4" />
      read on the phone, cleared on every device
    </p>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .max-h-0 {
    max-height: none;
  }

  .m-count-2,
  .m-dot {
    opacity: 0;
  }
}
</style>
