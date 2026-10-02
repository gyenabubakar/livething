<script setup lang="ts">
import { createTimeline } from 'animejs'

// One shared poll on two devices: a vote on the laptop moves the bar on the
// phone in the same moment.
const devices = [
  { name: 'laptop', icon: 'i-ph-laptop-duotone' },
  { name: 'phone', icon: 'i-ph-device-mobile-duotone' },
]
const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-tap', { opacity: [0, 1, 0], scale: [0.4, 1.4], duration: 600 }, 900)
  .add('.m-bar-yes', { width: ['60%', '65%'], duration: 500 }, 1300)
  .add('.m-bar-no', { width: ['40%', '35%'], duration: 500 }, 1300)
  .add('.m-yes-12', { opacity: 0, duration: 150 }, 1300)
  .add('.m-yes-13', { opacity: [0, 1], duration: 150 }, 1300)
  .add('.m-synced', { opacity: [0, 1, 1, 0], duration: 1600 }, 1400)
  .add('.m-scene', { opacity: 0, duration: 400 }, 5000)
  .add('.m-bar-yes', { width: '60%', duration: 1 }, 5400)
  .add('.m-bar-no', { width: '40%', duration: 1 }, 5400)
  .add('.m-yes-12', { opacity: 1, duration: 1 }, 5400)
  .add('.m-yes-13', { opacity: 0, duration: 1 }, 5400)
  .add('.m-scene', { opacity: 1, duration: 1 }, 5401))
</script>

<template>
  <div ref="root" class="w-full max-w-md">
    <div class="m-scene grid grid-cols-2 gap-3 font-sans text-[12px] text-zinc-200">
      <div v-for="(device, index) in devices" :key="device.name" class="relative border border-white/10 bg-zinc-950/85 p-4 shadow-2xl">
        <p class="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <UIcon :name="device.icon" class="size-4" /> {{ device.name }}
        </p>
        <p class="mt-3 font-medium text-white">
          Ship on Thursday?
        </p>
        <div class="mt-3 space-y-2">
          <div class="relative h-7 bg-white/5">
            <div class="m-bar-yes absolute inset-y-0 left-0 bg-orange-500/70" style="width: 60%" />
            <span class="absolute inset-y-0 left-2 flex items-center">Yes</span>
            <span class="absolute inset-y-0 right-2 flex items-center font-mono">
              <span class="m-yes-12">12</span><span class="m-yes-13 rm-show absolute right-0 opacity-0">13</span>
            </span>
            <span v-if="index === 0" class="m-tap absolute top-1/2 left-1/3 -mt-3 -ml-3 size-6 rounded-full border-2 border-white opacity-0" />
          </div>
          <div class="relative h-7 bg-white/5">
            <div class="m-bar-no absolute inset-y-0 left-0 bg-white/15" style="width: 40%" />
            <span class="absolute inset-y-0 left-2 flex items-center">No</span>
            <span class="absolute inset-y-0 right-2 flex items-center font-mono">8</span>
          </div>
        </div>
      </div>
    </div>
    <p class="m-synced mt-3 text-center text-[11px] text-orange-50/90 opacity-0">
      the phone updated in the same moment
    </p>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .m-yes-12 {
    opacity: 0;
  }
}
</style>
