<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

// The same Split Stream on HTTP/1.1 and on HTTP/2. HTTP/1.1 needs a connection for each open
// request, from six per site. HTTP/2 carries them all in one.
const parts = [
  { label: 'event stream', down: true },
  { label: 'batch POST', down: false },
  { label: 'ping and pong POST', down: false },
]
const BOX = { w: 56, y: 44, h: 150 }
const PIPE = 182
const sides = [
  { name: 'HTTP/1.1', x: 12, slots: 3, allowed: false },
  { name: 'HTTP/2', x: 352, slots: 1, allowed: true },
]
const PACKET = 8
const laneY = (side: number, index: number) => (side === 0 ? 81 + index * 46 : 100 + index * 27)
const pipeFrom = (x: number) => x + BOX.w + 6

const paused = ref(false)
const art = ref<SVGElement>()

useIllustration(art, () => {
  const travel = PIPE - PACKET
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'linear' } })
  for (const side of [0, 1]) {
    timeline
      .add(`.cn-down-${side}`, { translateX: [0, -travel], opacity: [0, 1, 1, 0], duration: 2200, delay: stagger(1100) }, 0)
      .add(`.cn-up-${side}`, { translateX: [0, travel], opacity: [0, 1, 1, 0], duration: 2200, delay: stagger(550) }, 150)
  }
  return timeline
}, { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="On HTTP/1.1 a Split Stream can hold three of the six connections a browser allows for one site, shared by every tab. On HTTP/2 it all fits in one connection, and only there can the client use stream mode.">
    <svg ref="art" viewBox="0 0 680 276" class="w-full" role="img" aria-label="Left, HTTP/1.1: three separate connections, three of the six a browser allows for one site. Right, HTTP/2: one connection carries the event stream and the POSTs together.">
      <line x1="340" y1="12" x2="340" y2="270" class="stroke-(--art-line)" />

      <g v-for="(side, sideIndex) in sides" :key="side.name">
        <text :x="side.x" y="24" class="font-mono text-[13px] font-semibold fill-(--ui-text-highlighted)">{{ side.name }}</text>

        <rect :x="side.x" :y="BOX.y" :width="BOX.w" :height="BOX.h" class="fill-(--art-top) stroke-(--art-line)" />
        <text :x="side.x + BOX.w / 2" :y="BOX.y + BOX.h / 2 + 4" text-anchor="middle" class="font-mono text-[11px] fill-(--ui-text-highlighted)">browser</text>
        <rect :x="side.x + BOX.w + PIPE + 12" :y="BOX.y" :width="BOX.w" :height="BOX.h" class="fill-(--art-top) stroke-orange-400/60" />
        <text :x="side.x + BOX.w * 1.5 + PIPE + 12" :y="BOX.y + BOX.h / 2 + 4" text-anchor="middle" class="font-mono text-[11px] fill-(--ui-text-highlighted)">server</text>

        <!-- HTTP/1.1: a pipe for each open request. HTTP/2: one wide pipe around all three. -->
        <template v-if="sideIndex === 0">
          <g v-for="(part, index) in parts" :key="part.label">
            <text :x="pipeFrom(side.x) + PIPE / 2" :y="laneY(0, index) - 16" text-anchor="middle" class="font-mono text-[10.5px] fill-(--ui-text-muted)">{{ part.label }}</text>
            <rect :x="pipeFrom(side.x)" :y="laneY(0, index) - 10" :width="PIPE" height="20" class="fill-(--art-top)/40 stroke-(--art-line)" />
          </g>
        </template>
        <template v-else>
          <rect :x="pipeFrom(side.x)" y="80" :width="PIPE" height="88" class="fill-orange-500/[0.06] stroke-orange-400/60" />
          <text :x="pipeFrom(side.x) + PIPE / 2" y="70" text-anchor="middle" class="font-mono text-[10.5px] fill-orange-700 dark:fill-orange-200">one connection</text>
        </template>

        <g v-for="(part, index) in parts" :key="`lane-${part.label}`">
          <line :x1="pipeFrom(side.x) + 6" :y1="laneY(sideIndex, index)" :x2="pipeFrom(side.x) + PIPE - 6" :y2="laneY(sideIndex, index)" :stroke="part.down ? '#ff8a3d' : '#38bdf8'" stroke-width="1.5" stroke-dasharray="2 4" class="opacity-50" />
          <rect
            v-for="packet in 2" :key="packet"
            :x="part.down ? pipeFrom(side.x) + PIPE - PACKET : pipeFrom(side.x)"
            :y="laneY(sideIndex, index) - PACKET / 2" :width="PACKET" :height="PACKET"
            :fill="part.down ? '#ffb36b' : '#7dd3fc'"
            :class="part.down ? `cn-down-${sideIndex} ss-glow-down` : `cn-up-${sideIndex} ss-glow-up`" class="opacity-0"
          />
          <text v-if="sideIndex === 1" :x="pipeFrom(side.x) + 8" :y="laneY(1, index) - 5" class="font-mono text-[9px] fill-(--ui-text-muted)">{{ part.label }}</text>
        </g>

        <!-- the six connections a browser allows for one site -->
        <text :x="side.x" y="222" class="font-mono text-[10.5px] uppercase tracking-widest fill-(--ui-text-muted)">connections to this site, all tabs</text>
        <rect v-for="slot in 6" :key="slot" :x="side.x + (slot - 1) * 24" y="232" width="18" height="14" :class="slot <= side.slots ? 'fill-orange-500/80' : 'fill-none stroke-(--art-line)'" />
        <text :x="side.x" y="266" class="font-mono text-[11px]" :class="side.allowed ? 'fill-emerald-600 dark:fill-emerald-300' : 'fill-red-600 dark:fill-red-300'">{{ side.slots }} of 6 · stream mode {{ side.allowed ? 'allowed' : 'not allowed' }}</text>
      </g>
    </svg>
  </SplitStreamFigure>
</template>
