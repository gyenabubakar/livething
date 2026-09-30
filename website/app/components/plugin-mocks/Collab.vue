<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

// Two people in one document: Kofi selects a phrase and comments on it while
// Amara types a new sentence. Both edits land without a conflict.
const typed = ' Amara owns the changelog.'.split('')
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-select', { opacity: [0, 1], duration: 300 }, 500)
  // Characters grow from zero size, so the caret after them moves and wraps with the text.
  .add('.m-char', { fontSize: ['0px', '12px'], duration: 1, delay: stagger(70) }, 900)
  .add('.m-comment', { opacity: [0, 1], scale: [0.6, 1], duration: 300, ease: 'outBack' }, 2000)
  .add('.m-synced', { opacity: [0, 1], duration: 300 }, 900 + typed.length * 70 + 200)
  .add('.m-scene', { opacity: 0, duration: 400 }, 6200)
  .add(['.m-select', '.m-comment', '.m-synced'], { opacity: 0, duration: 1 }, 6600)
  .add('.m-char', { fontSize: '0px', duration: 1 }, 6600)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6601))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene relative border border-white/10 bg-zinc-950/85 shadow-2xl">
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span class="flex items-center gap-2 font-medium text-white"><UIcon name="i-ph-file-text-duotone" class="size-4 text-zinc-400" /> Launch plan</span>
        <span class="flex -space-x-1.5">
          <span class="flex size-5 items-center justify-center border border-zinc-950 bg-orange-400 text-[10px] font-semibold text-zinc-950">A</span>
          <span class="flex size-5 items-center justify-center border border-zinc-950 bg-sky-400 text-[10px] font-semibold text-zinc-950">K</span>
        </span>
      </div>
      <div class="px-4 py-5">
        <p class="text-base font-semibold text-white">
          Thursday release
        </p>
        <p class="mt-3 pb-5 font-mono text-[12px] leading-6 text-zinc-300">
          We ship after the
          <span class="relative">
            <span class="m-select rm-show absolute -inset-x-0.5 inset-y-0 bg-sky-500/30 opacity-0" />
            <span class="relative">payments fix</span>
            <span class="m-select rm-show absolute -top-4 left-0 bg-sky-400 px-1 font-sans text-[10px] leading-4 text-zinc-950 opacity-0">kofi</span>
          </span>
          lands.<span v-for="(char, index) in typed" :key="index" class="m-char whitespace-pre text-[0px]">{{ char }}</span><span class="relative inline-block h-5 w-0.5 translate-y-1 bg-orange-400"><span class="absolute top-full left-0 mt-0.5 bg-orange-400 px-1 font-sans text-[10px] leading-4 text-zinc-950">amara</span></span>
        </p>
      </div>
      <span class="m-comment rm-show absolute top-[74px] -right-3 flex items-center gap-1 bg-sky-400 px-2 py-1 text-[11px] font-medium text-zinc-950 opacity-0">
        <UIcon name="i-ph-chat-teardrop-text-fill" class="size-3.5" /> 1
      </span>
      <p class="flex items-center gap-1.5 border-t border-white/10 px-4 py-2 text-[11px] text-zinc-400">
        <UIcon name="i-ph-check-circle-duotone" class="size-3.5 text-emerald-400" />
        <span class="m-synced rm-show opacity-0">both edits merged, no conflicts</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .m-char {
    font-size: 12px;
  }
}
</style>
