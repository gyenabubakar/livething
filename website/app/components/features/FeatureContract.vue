<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const art = ref<HTMLElement>()
const squiggle = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 2.5 1.5.5 3 2.5 4.5.5 6 2.5' fill='none' stroke='%23f87171'/%3E%3C/svg%3E")`

// A typo in an event name is a type error; typing the missing letter clears it.
useIllustration(art, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.c-squiggle', { scaleX: [0, 1], duration: 500 }, 600)
  .add('.c-error', { opacity: [0, 1], translateY: [6, 0], duration: 400 }, 1000)
  .add('.c-caret', { opacity: [0, 1], duration: 1 }, 3200)
  .add('.c-missing', { maxWidth: ['0ch', '1ch'], duration: 1 }, 3700)
  .add(['.c-error', '.c-squiggle'], { opacity: 0, duration: 250 }, 3800)
  .add('.c-ok', { opacity: [0, 1], translateY: [6, 0], duration: 400 }, 4100)
  .add('.c-caret', { opacity: 0, duration: 1 }, 5000)
  .add('.c-ok', { opacity: 0, duration: 300 }, 7000)
  .add('.c-missing', { maxWidth: '0ch', duration: 1 }, 7400)
  .add('.c-squiggle', { opacity: 1, scaleX: 0, duration: 1 }, 7400))
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <LandingGrainPanel class="absolute! inset-0">
        <div ref="art" class="flex size-full items-center justify-center p-6">
          <div class="w-full max-w-md border border-white/10 bg-zinc-950/90 font-mono text-[12px] leading-6 shadow-2xl">
            <div class="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-[11px] text-zinc-400">
              <UIcon name="i-vscode-icons-file-type-typescript" class="size-3.5" /> client/socket.ts
            </div>
            <pre class="overflow-hidden px-4 py-3 text-zinc-300"><span class="text-violet-400">import type</span> { ChatSocket } <span class="text-violet-400">from</span> <span class="text-emerald-300">'@monorepo/server/chat'</span>

socket.<span class="text-amber-300">on</span>(<span class="text-emerald-300">'message'</span>, (data) =&gt; {
  data.from <span class="text-zinc-500">// string</span>
})
socket.<span class="text-amber-300">send</span>(<span class="relative inline-block text-emerald-300">'send-me<span class="c-missing inline-block overflow-hidden align-bottom" style="max-width: 0ch">s</span><span class="c-caret inline-block h-4 w-px translate-y-0.5 bg-zinc-200 opacity-0" />sage'<span class="c-squiggle absolute inset-x-0 -bottom-0.5 h-[3px] origin-left scale-x-0" :style="{ backgroundImage: squiggle }" /></span>, { text })</pre>
            <div class="relative h-16 border-t border-white/10 px-4 py-2 text-[11px] leading-5">
              <p class="c-error rm-show absolute inset-x-4 text-red-300 opacity-0">
                Argument of type '"send-mesage"' is not assignable to parameter of type '"send-message"'.
              </p>
              <p class="c-ok absolute inset-x-4 text-emerald-300 opacity-0">
                ✓ checked against ChatSocket, inferred from the server
              </p>
            </div>
          </div>
        </div>
      </LandingGrainPanel>
    </template>
  </LandingFeatureCell>
</template>
