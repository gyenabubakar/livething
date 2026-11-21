<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const before = ['The launch', ' moves to', ' Thursday,', ' after the', ' payments fix', ' lands.']
const after = ['\n\nOwners:', ' Ama has', ' the changelog', ' and the demo.', ' Kofi has', ' the release notes,', ' and Ben runs', ' the final test', ' on Wednesday.']
const chunks = [...before, ...after]

const STEP = 380
const NUDGE_PAUSE = 1400

const art = ref<HTMLElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  chunks.forEach((_, index) => {
    const at = 300 + index * STEP + (index >= before.length ? NUDGE_PAUSE : 0)
    timeline
      .add(`.st-packet-${index}`, { left: ['0%', '100%'], opacity: [1, 1, 0], duration: 500, ease: 'inQuad' }, at)
      .add(`.st-chunk-${index}`, { opacity: [0, 1], filter: ['blur(4px)', 'blur(0px)'], duration: 300 }, at + 450)
  })
  const nudgeAt = 300 + before.length * STEP
  const endAt = nudgeAt + NUDGE_PAUSE + after.length * STEP + 300
  return timeline
    .add('.st-nudge', { left: ['100%', '0%'], opacity: [0, 1, 1, 0], duration: 900, ease: 'inOutQuad' }, nudgeAt)
    .add('.st-nudge-label', { opacity: [0, 1, 1, 0], duration: 1600 }, nudgeAt)
    .add('.st-done', { opacity: [0, 1], duration: 300 }, endAt)
    .add(['.st-done', ...chunks.map((_, i) => `.st-chunk-${i}`)], { opacity: 0, duration: 400 }, endAt + 2600)
})
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <LandingGrainPanel tone="dusk" class="absolute! inset-0">
        <div ref="art" class="flex size-full flex-col justify-center gap-5 p-6 sm:px-10 font-mono text-[11px]">
          <div class="flex items-center gap-3 text-zinc-300">
            <span class="shrink-0 border border-white/15 bg-zinc-950/70 px-2 py-1">server</span>
            <div class="relative h-6 flex-1">
              <div class="absolute inset-x-0 top-1/2 border-t border-dashed border-white/25" />
              <span
                v-for="(_, index) in chunks"
                :key="index"
                class="absolute top-1/2 size-2.5 -translate-y-1/2 bg-orange-300 shadow-[0_0_12px_#ff8a3d] opacity-0"
                :class="`st-packet-${index}`"
              />
              <span class="st-nudge absolute top-1/2 size-2.5 -translate-y-1/2 rotate-45 bg-sky-300 shadow-[0_0_12px_#7dd3fc] opacity-0" />
              <span class="st-nudge-label absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-sky-200 opacity-0">nudge('redirect', { instruction })</span>
            </div>
            <span class="shrink-0 border border-white/15 bg-zinc-950/70 px-2 py-1">client</span>
          </div>

          <div class="border border-white/10 bg-zinc-950/85 shadow-2xl">
            <div class="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-zinc-400">
              <span class="size-1.5 bg-orange-400" /> room.stream('ask-scout', { prompt })
              <span class="st-done ml-auto text-emerald-300 opacity-0">✓ done</span>
            </div>
            <p class="min-h-40 px-4 py-3 font-sans text-sm/6 text-zinc-100">
              <span
                v-for="(chunk, index) in chunks"
                :key="index"
                class="rm-show whitespace-pre-wrap opacity-0 decoration-orange-400/50 decoration-dotted underline underline-offset-4"
                :class="`st-chunk-${index}`"
              >{{ chunk }}</span>
            </p>
          </div>
        </div>
      </LandingGrainPanel>
    </template>
  </LandingFeatureCell>
</template>
