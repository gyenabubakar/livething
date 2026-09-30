<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

// An AI answer streams in word by word. The phone loses signal halfway, and
// when it reconnects the answer picks up where it stopped, with no word lost
// or repeated.
const first = 'Launch is on Thursday. Kofi is testing the payments fix tonight,'.split(' ')
const second = 'and Amara owns the changelog. Two blockers are left: the migration and the release notes.'.split(' ')
const WORD = 90
const root = ref<HTMLElement>()

const lostAt = 600 + first.length * WORD
const backAt = lostAt + 1600

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-first', { opacity: [0, 1], duration: 120, delay: stagger(WORD) }, 600)
  .add('.m-lost', { opacity: [0, 1], duration: 250 }, lostAt)
  .add('.m-lost', { opacity: 0, duration: 200 }, backAt)
  .add('.m-back', { opacity: [0, 1], duration: 250 }, backAt)
  .add('.m-second', { opacity: [0, 1], duration: 120, delay: stagger(WORD) }, backAt + 300)
  .add('.m-scene', { opacity: 0, duration: 400 }, backAt + 300 + second.length * WORD + 2200)
  .add(['.m-first', '.m-second', '.m-back'], { opacity: 0, duration: 1 }, backAt + 300 + second.length * WORD + 2600)
  .add('.m-scene', { opacity: 1, duration: 1 }, backAt + 300 + second.length * WORD + 2601))
</script>

<template>
  <div ref="root" class="w-full max-w-sm font-sans text-[13px] text-zinc-200">
    <div class="m-scene border border-white/10 bg-zinc-950/85 shadow-2xl">
      <p class="flex justify-end border-b border-white/10 px-4 py-3">
        <span class="bg-orange-500/20 px-3 py-1.5 text-orange-50">Summarise #launch for me</span>
      </p>
      <div class="px-4 py-4">
        <p class="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <UIcon name="i-ph-sparkle-duotone" class="size-3.5 text-orange-300" /> assistant
        </p>
        <p class="mt-2 min-h-[4.5rem] leading-6">
          <span v-for="(word, index) in first" :key="`a${index}`" class="m-first rm-show opacity-0">{{ `${word} ` }}</span>
          <span v-for="(word, index) in second" :key="`b${index}`" class="m-second rm-show opacity-0">{{ `${word} ` }}</span>
        </p>
      </div>
      <div class="relative h-9 border-t border-white/10 text-[11px]">
        <p class="m-lost absolute inset-0 flex items-center gap-1.5 bg-red-500/10 px-4 text-red-300 opacity-0">
          <UIcon name="i-ph-wifi-slash-duotone" class="size-3.5" /> signal lost, the server keeps writing
        </p>
        <p class="m-back rm-show absolute inset-0 flex items-center gap-1.5 bg-emerald-500/10 px-4 text-emerald-300 opacity-0">
          <UIcon name="i-ph-arrows-clockwise-duotone" class="size-3.5" /> reconnected, resumed at word {{ first.length + 1 }}
        </p>
      </div>
    </div>
  </div>
</template>
