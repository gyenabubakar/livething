<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const primitives = ['channels()', 'clientRequests()', 'stream()', 'reconnection()', 'buffering()', 'dedup()', 'replay()', 'keepalive()']
const BASE_BYTES = packageSize('client.minimal')
const ALL_BYTES = packageSize('client.all')

const art = ref<HTMLElement>()

// Import every primitive and the bundle grows to its full size; drop them and
// the bundler leaves them out again.
useIllustration(art, () => createTimeline({ loop: true, autoplay: false, alternate: true, loopDelay: 1600, defaults: { ease: 'outQuad' } })
  .add('.tn-line', { opacity: [0.25, 1], translateX: [-6, 0], duration: 250, delay: (_: unknown, i: number) => i * 160 }, 600)
  .add('.tn-bar', { width: [`${(BASE_BYTES / ALL_BYTES) * 100}%`, '100%'], duration: 8 * 160 + 250, ease: 'inOutSine' }, 600)
  .add('.tn-base', { opacity: [1, 0], duration: 200 }, 600)
  .add('.tn-all', { opacity: [0, 1], duration: 200 }, 8 * 160 + 700))
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div ref="art" class="absolute inset-0 grid grid-cols-[auto_1fr] items-center gap-8 px-6 sm:px-10 font-mono text-[12px]">
        <pre class="leading-6 text-toned"><span class="text-amber-600 dark:text-amber-300">client</span>&lt;ChatSocket&gt;()(
  <span class="text-highlighted">connect</span>(url),
<span v-for="primitive in primitives" :key="primitive" class="tn-line block opacity-25">  {{ primitive }},</span>)</pre>
        <div>
          <div class="relative mb-2 h-4 text-[11px]">
            <span class="tn-base absolute text-muted">connect only · <span class="text-highlighted">{{ formatPackageSize(BASE_BYTES) }}</span></span>
            <span class="tn-all absolute text-muted opacity-0">every primitive · <span class="text-highlighted">{{ formatPackageSize(ALL_BYTES) }}</span></span>
          </div>
          <div class="h-3 border border-default">
            <div class="tn-bar h-full bg-[repeating-linear-gradient(135deg,#ff8a3d_0_4px,#db5108_4px_8px)]" :style="{ width: `${(BASE_BYTES / ALL_BYTES) * 100}%` }" />
          </div>
          <p class="mt-2 text-[10px] text-dimmed">
            min + gzip
          </p>
        </div>
      </div>
    </template>
  </LandingFeatureCell>
</template>
