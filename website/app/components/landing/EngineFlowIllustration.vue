<script setup lang="ts">
// The Engine feature as a left-to-right flow: any transport reaches any runtime
// adapter, every adapter feeds the same engine, and your app sits on the engine.
const transports = ['websocket()', 'http()']
const adapters = [
  { name: 'Cloudflare', src: '/logos/cloudflare.svg' },
  { name: 'Node.js', src: '/logos/nodejs.svg' },
  { name: 'Bun', src: '/logos/bun.svg' },
]
const runs = ['contract', 'channels', 'requests', 'streams', 'presence']

const TRANSPORT = { x: 20, w: 150, h: 32, gap: 14 }
const ADAPTER = { x: 230, w: 150, h: 36, gap: 10 }
const ENGINE = { x: 440, y: 120, w: 220, h: 156 }
const APP = { x: 440, y: 56, w: 220, h: 44 }
const CHIP = { w: 90, h: 24, gap: 8 }
const BUS_IN = 200
const BUS_OUT = 410
const MIDDLE = ENGINE.y + ENGINE.h / 2

function column(count: number, height: number, gap: number) {
  const total = count * height + (count - 1) * gap
  return Array.from({ length: count }, (_, index) => MIDDLE - total / 2 + index * (height + gap))
}

const transportRows = column(transports.length, TRANSPORT.h, TRANSPORT.gap)
const adapterRows = column(adapters.length, ADAPTER.h, ADAPTER.gap)
const busTop = Math.min(transportRows[0]!, adapterRows[0]!) + ADAPTER.h / 2
const busBottom = adapterRows.at(-1)! + ADAPTER.h / 2
</script>

<template>
  <svg viewBox="0 40 680 290" class="size-full" role="img" aria-label="The websocket() or http() transport reaches a Cloudflare, Node.js or Bun adapter, and every adapter feeds the same LiveThing engine that runs your app">
    <text :x="TRANSPORT.x" :y="transportRows[0]! - 14" class="text-[10px] font-medium uppercase tracking-widest fill-zinc-500">Transport</text>
    <text :x="ADAPTER.x" :y="adapterRows[0]! - 14" class="text-[10px] font-medium uppercase tracking-widest fill-zinc-500">Adapter</text>

    <!-- transports into the first bus -->
    <g v-for="(transport, index) in transports" :key="transport">
      <rect :x="TRANSPORT.x" :y="transportRows[index]" :width="TRANSPORT.w" :height="TRANSPORT.h" class="fill-(--art-top) stroke-(--art-line)" />
      <text :x="TRANSPORT.x + TRANSPORT.w / 2" :y="transportRows[index]! + TRANSPORT.h / 2 + 4" text-anchor="middle" class="font-mono text-[12px] fill-orange-600 dark:fill-orange-200">{{ transport }}</text>
      <line :x1="TRANSPORT.x + TRANSPORT.w" :y1="transportRows[index]! + TRANSPORT.h / 2" :x2="BUS_IN" :y2="transportRows[index]! + TRANSPORT.h / 2" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />
    </g>
    <line :x1="BUS_IN" :y1="busTop" :x2="BUS_IN" :y2="busBottom" stroke="#ff8a3d" stroke-width="2" class="opacity-40" />

    <!-- every adapter hears every transport and feeds the second bus -->
    <g v-for="(adapter, index) in adapters" :key="adapter.name">
      <line :x1="BUS_IN" :y1="adapterRows[index]! + ADAPTER.h / 2" :x2="ADAPTER.x" :y2="adapterRows[index]! + ADAPTER.h / 2" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />
      <rect :x="ADAPTER.x" :y="adapterRows[index]" :width="ADAPTER.w" :height="ADAPTER.h" class="fill-(--art-top) stroke-(--art-line)" />
      <image :href="adapter.src" :x="ADAPTER.x + 14" :y="adapterRows[index]! + (ADAPTER.h - 22) / 2" width="22" height="22" preserveAspectRatio="xMidYMid meet" :class="adapter.class" />
      <text :x="ADAPTER.x + 46" :y="adapterRows[index]! + ADAPTER.h / 2 + 5" class="text-[14px] font-medium fill-(--ui-text-highlighted)">{{ adapter.name }}</text>
      <line :x1="ADAPTER.x + ADAPTER.w" :y1="adapterRows[index]! + ADAPTER.h / 2" :x2="BUS_OUT" :y2="adapterRows[index]! + ADAPTER.h / 2" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />
    </g>
    <line :x1="BUS_OUT" :y1="adapterRows[0]! + ADAPTER.h / 2" :x2="BUS_OUT" :y2="busBottom" stroke="#ff8a3d" stroke-width="2" class="opacity-40" />
    <line :x1="BUS_OUT" :y1="MIDDLE" :x2="ENGINE.x" :y2="MIDDLE" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />

    <!-- your app, plugged into the engine -->
    <rect :x="APP.x" :y="APP.y" :width="APP.w" :height="APP.h" fill="#e14300" stroke="#ffb36b" />
    <text :x="APP.x + 16" :y="APP.y + APP.h / 2 + 5" class="text-[15px] font-semibold fill-white">Your app</text>
    <text :x="APP.x + APP.w - 16" :y="APP.y + APP.h / 2 + 4" text-anchor="end" class="font-mono text-[11px] fill-orange-100">one codebase</text>
    <line :x1="APP.x + APP.w / 2" :y1="APP.y + APP.h" :x2="APP.x + APP.w / 2" :y2="ENGINE.y" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />

    <!-- the engine: routes every message and runs the features -->
    <rect :x="ENGINE.x" :y="ENGINE.y" :width="ENGINE.w" :height="ENGINE.h" class="fill-(--art-top) stroke-orange-400/70" />
    <g :transform="`translate(${ENGINE.x + 16} ${ENGINE.y + 14})`">
      <AppLogoMark width="18" height="25" />
    </g>
    <text :x="ENGINE.x + 42" :y="ENGINE.y + 32" class="text-[15px] font-semibold fill-(--ui-text-highlighted)">LiveThing engine</text>
    <g v-for="(feature, index) in runs" :key="feature">
      <rect
        :x="ENGINE.x + 16 + (index % 2) * (CHIP.w + CHIP.gap)"
        :y="ENGINE.y + 50 + Math.floor(index / 2) * (CHIP.h + CHIP.gap)"
        :width="CHIP.w" :height="CHIP.h"
        class="fill-orange-500/[0.07] stroke-orange-400/30"
      />
      <text
        :x="ENGINE.x + 16 + (index % 2) * (CHIP.w + CHIP.gap) + 10"
        :y="ENGINE.y + 50 + Math.floor(index / 2) * (CHIP.h + CHIP.gap) + 16"
        class="font-mono text-[11px] fill-(--ui-text-muted)"
      >{{ feature }}</text>
    </g>

    <text x="340" y="316" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">Swap the transport or the runtime. Your app code stays the same.</text>
  </svg>
</template>
