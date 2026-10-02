<script setup lang="ts">
import { createTimeline } from 'animejs'

// A short chat exchange: messages land, a reply is read, a reaction counts up
// and someone starts typing.
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-msg-1', { opacity: [0, 1], translateY: [8, 0], duration: 350 }, 300)
  .add('.m-msg-2', { opacity: [0, 1], translateY: [8, 0], duration: 350 }, 1100)
  .add('.m-read', { opacity: [0, 1], duration: 250 }, 2000)
  .add('.m-react', { opacity: [0, 1], scale: [0.6, 1], duration: 300, ease: 'outBack' }, 2500)
  .add('.m-count-1', { opacity: 0, duration: 150 }, 3200)
  .add('.m-count-2', { opacity: [0, 1], duration: 150 }, 3200)
  .add('.m-typing', { opacity: [0, 1], duration: 250 }, 3600)
  .add('.m-typing', { opacity: 0, duration: 200 }, 5000)
  .add('.m-msg-3', { opacity: [0, 1], translateY: [8, 0], duration: 350 }, 5100)
  .add('.m-scene', { opacity: 0, duration: 400 }, 7400)
  .add(['.m-msg-1', '.m-msg-2', '.m-msg-3', '.m-read', '.m-react', '.m-count-2', '.m-typing'], { opacity: 0, duration: 1 }, 7800)
  .add('.m-count-1', { opacity: 1, duration: 1 }, 7800)
  .add('.m-scene', { opacity: 1, duration: 1 }, 7801))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene border border-white/10 bg-zinc-950/85 shadow-2xl">
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span class="font-medium text-white"># launch</span>
        <span class="flex items-center gap-1.5 text-[11px] text-zinc-400"><span class="size-1.5 rounded-full bg-emerald-400" /> 3 online</span>
      </div>
      <div class="space-y-3 px-4 py-4">
        <div class="m-msg-1 rm-show w-fit max-w-[80%] opacity-0">
          <p class="text-[11px] text-orange-300">amara</p>
          <p class="mt-0.5 bg-white/[0.06] px-3 py-2">shipping the fix tonight</p>
          <span class="m-react rm-show relative mt-1 inline-flex items-center gap-1 border border-white/10 px-1.5 text-[11px] opacity-0">
            🎉
            <span class="relative inline-block w-2">
              <span class="m-count-1 absolute inset-0">1</span>
              <span class="m-count-2 rm-show absolute inset-0 opacity-0">2</span>
            </span>
          </span>
        </div>
        <div class="m-msg-2 rm-show ml-auto w-fit max-w-[80%] opacity-0">
          <p class="bg-orange-500/20 px-3 py-2 text-orange-50">nice, I will test it first thing</p>
          <p class="mt-1 flex items-center justify-end gap-1 text-[10px] text-zinc-500">
            <span class="relative">
              ✓✓
              <span class="m-read rm-show absolute inset-0 text-orange-300 opacity-0">✓✓</span>
            </span>
            read
          </p>
        </div>
        <div class="relative h-12">
          <p class="m-typing absolute inset-x-0 top-0 flex items-center gap-2 text-[11px] text-zinc-400 opacity-0">
            <span class="typing flex gap-0.5"><i /><i /><i /></span> ben is typing
          </p>
          <div class="m-msg-3 rm-show absolute top-0 w-fit opacity-0">
            <p class="text-[11px] text-sky-300">ben</p>
            <p class="mt-0.5 bg-white/[0.06] px-3 py-2">go go go 🚀</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.typing i {
  display: block;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
  animation: typing 1.2s infinite;
}

.typing i:nth-child(2) { animation-delay: 0.15s; }
.typing i:nth-child(3) { animation-delay: 0.3s; }

@media (prefers-reduced-motion: reduce) {
  .m-count-1 {
    opacity: 0;
  }
}

@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: none; }
  30% { opacity: 1; transform: translateY(-2px); }
}
</style>
