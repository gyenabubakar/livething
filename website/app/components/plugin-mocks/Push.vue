<script setup lang="ts">
import { createTimeline } from 'animejs'

// A locked phone: the app is closed, so the messages arrive as push
// notifications, newest on top.
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-note-1', { maxHeight: [0, 72], opacity: [0, 1], duration: 450 }, 600)
  .add('.m-note-2', { maxHeight: [0, 72], opacity: [0, 1], duration: 450 }, 2200)
  .add('.m-note-1', { opacity: 0.6, duration: 300 }, 2200)
  .add('.m-scene', { opacity: 0, duration: 400 }, 5600)
  .add(['.m-note-1', '.m-note-2'], { maxHeight: 0, opacity: 0, duration: 1 }, 6000)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6001))
</script>

<template>
  <div ref="root" class="flex w-full max-w-sm flex-col items-center font-sans text-[12px] text-zinc-200">
    <p class="mb-3 flex items-center gap-1.5 text-[11px] text-orange-100/80">
      <UIcon name="i-ph-moon-duotone" class="size-3.5" /> app closed, socket gone
    </p>
    <div class="m-scene relative h-[300px] w-[230px] overflow-hidden rounded-[30px] border border-white/15 bg-zinc-950/80 px-3 pt-8 shadow-2xl">
      <span class="absolute top-2.5 left-1/2 h-4 w-16 -translate-x-1/2 rounded-full bg-black" />
      <p class="text-center text-[11px] text-zinc-400">Tuesday 30 September</p>
      <p class="text-center text-4xl font-light tracking-tight text-white">9:41</p>
      <div class="mt-4 space-y-2">
        <div class="m-note-2 rm-show max-h-0 overflow-hidden opacity-0">
          <div class="flex gap-2.5 rounded-xl bg-white/10 p-2.5 backdrop-blur">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-500"><UIcon name="i-ph-at-bold" class="size-4 text-zinc-950" /></span>
            <div class="min-w-0">
              <p class="flex justify-between gap-2 font-medium text-white">Chat <span class="font-normal text-zinc-400">now</span></p>
              <p class="truncate text-zinc-300">kofi mentioned you in #launch</p>
            </div>
          </div>
        </div>
        <div class="m-note-1 rm-show max-h-0 overflow-hidden opacity-0">
          <div class="flex gap-2.5 rounded-xl bg-white/10 p-2.5 backdrop-blur">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-500"><UIcon name="i-ph-chats-circle-bold" class="size-4 text-zinc-950" /></span>
            <div class="min-w-0">
              <p class="flex justify-between gap-2 font-medium text-white">Chat <span class="font-normal text-zinc-400">2m ago</span></p>
              <p class="truncate text-zinc-300">amara: shipping the fix tonight</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .max-h-0 {
    max-height: none;
  }
}
</style>
