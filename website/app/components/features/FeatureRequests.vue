<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const calls = [
  { id: 1, event: 'get-profile', replyAt: 2900 },
  { id: 2, event: 'load-history', replyAt: 1500 },
  { id: 3, event: 'delete-message', replyAt: 2200 },
]

const art = ref<HTMLElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
  calls.forEach((call, index) => {
    const sentAt = 300 + index * 180
    timeline
      .add(`.rq-out-${index}`, { left: ['0%', '100%'], opacity: [1, 1, 0], duration: 700 }, sentAt)
      .add(`.rq-back-${index}`, { left: ['100%', '0%'], opacity: [1, 1, 0], duration: 700 }, call.replyAt)
      .add(`.rq-pending-${index}`, { opacity: [1, 0], duration: 150 }, call.replyAt + 650)
      .add(`.rq-done-${index}`, { opacity: [0, 1], scale: [0.8, 1], duration: 300, ease: 'outBack' }, call.replyAt + 650)
  })
  return timeline
    .add('.rq-order', { opacity: [0, 1], duration: 400 }, 3700)
    .add(['.rq-order', ...calls.map((_, i) => `.rq-done-${i}`)], { opacity: 0, duration: 300 }, 6200)
    .add(calls.map((_, i) => `.rq-pending-${i}`), { opacity: 1, duration: 300 }, 6300)
})
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div ref="art" class="art-origin absolute inset-0 flex flex-col justify-center gap-4 px-6 sm:px-10 font-mono text-[11px] bg-[linear-gradient(to_bottom,transparent,rgb(244_97_15/0.06))]">
        <div class="grid grid-cols-[minmax(0,15rem)_1fr_4.5rem] items-center gap-x-3 gap-y-5">
          <template v-for="(call, index) in calls" :key="call.id">
            <div class="border border-default bg-elevated/40 px-3 py-2 text-toned">
              <span class="text-violet-400">await</span> request(<span class="text-emerald-600 dark:text-emerald-300">'{{ call.event }}'</span>)
              <div class="relative mt-1 h-4">
                <span class="absolute text-muted" :class="`rq-pending-${index}`">pending…</span>
                <span class="absolute text-emerald-600 dark:text-emerald-300 opacity-0" :class="`rq-done-${index}`">✓ reply #{{ call.id }}</span>
              </div>
            </div>
            <div class="relative h-full">
              <div class="absolute inset-x-0 top-1/2 border-t border-dashed border-(--art-line)" />
              <span class="absolute top-1/2 -translate-y-[calc(50%+7px)] bg-orange-400 px-1 text-[10px] text-zinc-950 opacity-0" :class="`rq-out-${index}`">#{{ call.id }}</span>
              <span class="absolute top-1/2 translate-y-[calc(-50%+7px)] bg-emerald-400 px-1 text-[10px] text-zinc-950 opacity-0" :class="`rq-back-${index}`">#{{ call.id }}</span>
            </div>
            <div v-if="index === 0" class="row-span-3 flex h-full items-center justify-center border border-orange-400/40 bg-orange-500/[0.06] text-orange-600 dark:text-orange-200 [writing-mode:vertical-rl]">
              server
            </div>
          </template>
        </div>
        <p class="rq-order text-muted opacity-0">
          replies arrived #2, #3, #1 · each one reached its own call
        </p>
      </div>
    </template>
  </LandingFeatureCell>
</template>
