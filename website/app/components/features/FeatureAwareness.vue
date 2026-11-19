<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const ROW = 56
const messages = [
  { from: 'kofi', text: 'The draft is up for review' },
  { from: 'amara', text: 'Can we ship it Thursday?' },
  { from: 'ada', text: 'Yes, after the demo' },
]
// Where each reader starts, by message row.
const readers = [
  { name: 'kofi', row: 0, dot: 'bg-sky-400' },
  { name: 'amara', row: 1, dot: 'bg-orange-400' },
]

const art = ref<HTMLElement>()

// Kofi moves to the last message and everyone sees it, Amara moves up to the
// first one, and once nothing moves, a guest's update is refused by the check.
useIllustration(art, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
  .add('.a-code', { opacity: [0, 1], translateY: [6, 0], duration: 400 }, 500)
  .add('.a-kofi', { translateY: [0, 2 * ROW], duration: 700 }, 1100)
  .add('.a-ok', { opacity: [0, 1, 1, 0], duration: 1800 }, 1300)
  .add('.a-amara', { translateY: [0, -ROW], duration: 700 }, 2200)
  .add('.a-refused', { opacity: [0, 1, 1, 0], duration: 1800 }, 3900)
  .add('.a-scene', { opacity: 0, duration: 400 }, 6000)
  .add('.a-code', { opacity: 0, duration: 1 }, 6400)
  .add(['.a-kofi', '.a-amara'], { translateY: 0, duration: 1 }, 6400)
  .add('.a-scene', { opacity: 1, duration: 300 }, 6401))
</script>

<template>
  <LandingFeatureCell :link :link-label wide>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <LandingGrainPanel tone="dusk" class="absolute! inset-0">
        <div ref="art" class="flex size-full items-center justify-center p-6">
          <div role="img" aria-label="Members of a room see which message each other member is reading, and a guest's update is refused" class="a-scene w-full max-w-md border border-white/10 bg-zinc-950/90 font-sans text-[12px] text-zinc-200 shadow-2xl">
            <div class="flex items-center justify-between border-b border-white/10 px-4 py-2 font-mono text-[11px] text-zinc-400">
              room:general
              <span class="flex items-center gap-1.5 text-zinc-500">
                <span class="size-2 rounded-full bg-sky-400" />
                <span class="size-2 rounded-full bg-orange-400" />
                <span class="size-2 rounded-full bg-emerald-400" />
                3 here
              </span>
            </div>

            <div class="relative">
              <div
                v-for="(message, index) in messages"
                :key="message.text"
                class="flex flex-col justify-center border-b border-white/5 pr-28 pl-4"
                :style="{ height: `${ROW}px` }"
              >
                <p class="text-[11px] text-zinc-500">
                  {{ message.from }} · m{{ index + 1 }}
                </p>
                <p class="mt-0.5 text-zinc-200">
                  {{ message.text }}
                </p>
              </div>

              <span
                v-for="reader in readers"
                :key="reader.name"
                :class="`a-${reader.name}`"
                class="absolute right-4 flex items-center gap-1.5 bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                :style="{ top: `${reader.row * ROW + 18}px` }"
              >
                <span class="size-1.5 rounded-full" :class="reader.dot" />
                {{ reader.name }} reading
              </span>
            </div>

            <div class="px-4 py-2 font-mono text-[11px] leading-5">
              <p class="a-code rm-show text-zinc-300 opacity-0">
                room.awareness.<span class="text-amber-300">set</span>({ viewingMessageId: <span class="text-emerald-300">'m3'</span>, editingTopic: <span class="text-emerald-300">false</span> })
              </p>
              <div class="mt-1 grid">
                <p class="a-ok text-emerald-300 opacity-0 [grid-area:1/1]">
                  ✓ checked, sent to everyone in the room
                </p>
                <p class="a-refused text-red-300 opacity-0 [grid-area:1/1]">
                  ✗ guest's update refused: nobody sees it
                </p>
              </div>
            </div>
          </div>
        </div>
      </LandingGrainPanel>
    </template>
  </LandingFeatureCell>
</template>

<style scoped>
/* Without motion, show where the readers end up. */
@media (prefers-reduced-motion: reduce) {
  .a-kofi {
    transform: translateY(112px);
  }

  .a-amara {
    transform: translateY(-56px);
  }
}
</style>
