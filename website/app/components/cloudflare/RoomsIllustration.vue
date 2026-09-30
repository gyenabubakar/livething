<script setup lang="ts">
import { createTimeline } from 'animejs'

// Cloudflare's network as one slab, with a grid of rooms on it. Every room is
// its own Durable Object: it sleeps while quiet, and a message dropping in from
// above wakes it for a moment before it goes back to sleep.
const O = { ox: 320, oy: 250 }
const SLAB = 420
const slab = isoBox(O, -SLAB / 2, -SLAB / 2, -16, SLAB, SLAB, 16)
const cfMatrix = isoTopMatrix(O, SLAB / 2 - 110, SLAB / 2 - 38, 0)

const COUNT = 4
const SIZE = 58
const GAP = 34
const HEIGHT = 34
const START = -(COUNT * SIZE + (COUNT - 1) * GAP) / 2

const names: Record<number, string> = {
  1: 'room:launch',
  6: 'doc:roadmap',
  11: 'user:amara',
  12: 'game:4512',
}

const rooms = Array.from({ length: COUNT * COUNT }, (_, index) => {
  const x = START + (index % COUNT) * (SIZE + GAP)
  const y = START + Math.floor(index / COUNT) * (SIZE + GAP)
  const [cx, cy] = iso(O, x + SIZE / 2, y + SIZE / 2, HEIGHT)
  return {
    index,
    depth: x + y,
    faces: isoBox(O, x, y, 0, SIZE, SIZE, HEIGHT),
    labelMatrix: isoTopMatrix(O, x + 6, y + SIZE / 2 + 3, HEIGHT),
    name: names[index],
    top: [cx, cy] as [number, number],
  }
}).sort((a, b) => a.depth - b.depth)

// The order rooms wake in. Neighbours never wake back to back, so it reads as
// traffic arriving from all over rather than a sweep.
const wakes = [5, 10, 1, 14, 7, 12, 3, 9, 6, 15, 0, 11]
const STEP = 650
const HOLD = 1500

const root = ref<SVGElement>()

useIllustration(root, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  wakes.forEach((room, order) => {
    const at = order * STEP
    timeline
      .add(`.beam-${room}`, { opacity: [0, 1], duration: 250 }, at)
      .add(`.lift-${room}`, { translateY: [0, -10], duration: 350 }, at + 250)
      .add(`.awake-${room}`, { opacity: [0, 1], duration: 350 }, at + 250)
      .add(`.beam-${room}`, { opacity: 0, duration: 400 }, at + 700)
      .add(`.lift-${room}`, { translateY: 0, duration: 700, ease: 'inOutSine' }, at + 250 + HOLD)
      .add(`.awake-${room}`, { opacity: 0, duration: 700, ease: 'inOutSine' }, at + 250 + HOLD)
  })
  return timeline
})
</script>

<template>
  <svg ref="root" viewBox="0 0 640 520" class="h-auto w-full" role="img" aria-label="A grid of rooms on Cloudflare's network. Each room is its own Durable Object that sleeps while quiet and wakes when a message arrives.">
    <defs>
      <linearGradient id="rooms-awake-left" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#ffb36b" />
        <stop offset="1" stop-color="#e14300" />
      </linearGradient>
      <pattern id="rooms-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M20 0H0V20" fill="none" class="stroke-(--art-line)" stroke-width="0.6" />
      </pattern>
    </defs>

    <!-- the network: one wide slab with a faint grid and the Cloudflare mark -->
    <polygon :points="slab.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
    <polygon :points="slab.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
    <polygon :points="slab.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
    <g :transform="isoTopMatrix(O, -SLAB / 2, -SLAB / 2, 0)" class="opacity-60">
      <rect :width="SLAB" :height="SLAB" fill="url(#rooms-grid)" />
    </g>
    <g :transform="cfMatrix">
      <image href="/logos/cloudflare.svg" width="64" height="30" preserveAspectRatio="xMidYMid meet" />
    </g>

    <g v-for="room in rooms" :key="room.index">
      <line
        :x1="room.top[0]" y1="-10" :x2="room.top[0]" :y2="room.top[1] - 10"
        stroke="#ff8a3d" stroke-width="2"
        class="dash-flow opacity-0" :class="`beam-${room.index}`"
      />
      <g :class="`lift-${room.index}`">
        <polygon :points="room.faces.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
        <polygon :points="room.faces.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
        <polygon :points="room.faces.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
        <g class="opacity-0" :class="`awake-${room.index}`">
          <polygon :points="room.faces.left" fill="url(#rooms-awake-left)" stroke="#ffb36b" stroke-linejoin="round" />
          <polygon :points="room.faces.right" fill="#b83500" stroke="#ff8a3d" stroke-linejoin="round" />
          <polygon :points="room.faces.top" class="fill-zinc-950" stroke="#ff8a3d" stroke-linejoin="round" />
        </g>
        <g v-if="room.name" :transform="room.labelMatrix">
          <text class="font-mono text-[10px] fill-zinc-500 dark:fill-zinc-400">{{ room.name }}</text>
        </g>
      </g>
    </g>
  </svg>
</template>
