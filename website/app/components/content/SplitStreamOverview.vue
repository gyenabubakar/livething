<script setup lang="ts">
// The whole idea in one picture: one stream down (server-sent events), one stream up (a POST
// whose body stays open), both inside one HTTP/2 connection.
const LANE = { from: 138, to: 542 }
const DOWN_Y = 104
const UP_Y = 162
const down = ['message', 'reaction']
const up = ['send-message', 'react']
const CHIP_H = 26
const CHIP_MAX = 112
const TRAVEL = LANE.to - LANE.from - CHIP_MAX
const SECONDS = 8

function chipWidth(label: string) {
  return label.length * 7.6 + 18
}
</script>

<template>
  <SplitStreamFigure animated caption="A Split Stream: events come down on a server-sent events stream, and messages go up in the body of one POST that stays open. On HTTP/2, both are inside one connection.">
    <svg viewBox="0 0 680 250" class="w-full" role="img" aria-label="A browser and a server joined by one connection. Inside it, server-sent events flow from the server to the browser, and messages flow from the browser to the server in the body of one long POST request.">
      <!-- the one connection -->
      <rect x="128" y="66" width="424" height="134" rx="22" class="fill-orange-500/[0.04] stroke-(--art-line)" stroke-dasharray="5 5" />
      <text x="340" y="56" text-anchor="middle" class="text-[12.5px] font-medium uppercase tracking-wider fill-(--ui-text-muted)">One HTTP/2 connection</text>

      <!-- browser -->
      <rect x="12" y="56" width="116" height="154" rx="10" class="fill-(--ui-bg) stroke-(--art-line)" />
      <line x1="12" y1="80" x2="128" y2="80" class="stroke-(--art-line)" />
      <circle cx="26" cy="68" r="3.5" class="fill-red-400/70" />
      <circle cx="38" cy="68" r="3.5" class="fill-amber-400/70" />
      <circle cx="50" cy="68" r="3.5" class="fill-green-400/70" />
      <text x="70" y="126" text-anchor="middle" class="text-[16px] font-semibold fill-(--ui-text-highlighted)">Browser</text>
      <text x="70" y="147" text-anchor="middle" class="font-mono text-[13px] fill-(--ui-text-muted)">Huddle tab</text>
      <rect x="28" y="164" width="84" height="8" rx="4" class="fill-(--ui-text-muted)/15" />
      <rect x="28" y="178" width="60" height="8" rx="4" class="fill-(--ui-text-muted)/15" />

      <!-- server -->
      <rect x="552" y="56" width="116" height="154" rx="10" class="fill-(--ui-bg) stroke-orange-400/70" />
      <g transform="translate(566 70)">
        <AppLogoMark width="16" height="22" />
      </g>
      <text x="610" y="126" text-anchor="middle" class="text-[16px] font-semibold fill-(--ui-text-highlighted)">Server</text>
      <text x="610" y="147" text-anchor="middle" class="font-mono text-[13px] fill-(--ui-text-muted)">LiveThing</text>
      <rect x="568" y="164" width="84" height="8" rx="4" class="fill-orange-400/20" />
      <rect x="568" y="178" width="60" height="8" rx="4" class="fill-orange-400/20" />

      <!-- the stream down -->
      <text x="340" y="86" text-anchor="middle" class="text-[13.5px] font-medium fill-orange-600 dark:fill-orange-300">← down: one GET held open (server-sent events)</text>
      <line :x1="LANE.from" :y1="DOWN_Y" :x2="LANE.to" :y2="DOWN_Y" stroke="#ff8a3d" stroke-width="2" class="opacity-40" />
      <g v-for="(label, index) in down" :key="`d${index}`" class="ss-chip" :style="{ '--i': index, '--travel': `${-TRAVEL}px`, transform: `translateX(${-(index + 0.5) * (TRAVEL / 2)}px)` }">
        <rect :x="LANE.to - chipWidth(label)" :y="DOWN_Y - CHIP_H / 2" :width="chipWidth(label)" :height="CHIP_H" rx="11" fill="#ff8a3d" />
        <text :x="LANE.to - chipWidth(label) / 2" :y="DOWN_Y + 4.5" text-anchor="middle" class="font-mono text-[12.5px] fill-white">{{ label }}</text>
      </g>

      <!-- the stream up -->
      <line :x1="LANE.from" :y1="UP_Y" :x2="LANE.to" :y2="UP_Y" stroke-width="2" class="stroke-sky-500 opacity-40 dark:stroke-sky-400" />
      <g v-for="(label, index) in up" :key="`u${index}`" class="ss-chip" :style="{ '--i': index, '--travel': `${TRAVEL}px`, transform: `translateX(${(index + 0.5) * (TRAVEL / 2)}px)` }">
        <rect :x="LANE.from" :y="UP_Y - CHIP_H / 2" :width="chipWidth(label)" :height="CHIP_H" rx="11" class="fill-sky-500 dark:fill-sky-400" />
        <text :x="LANE.from + chipWidth(label) / 2" :y="UP_Y + 4.5" text-anchor="middle" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">{{ label }}</text>
      </g>
      <text x="340" y="192" text-anchor="middle" class="text-[13.5px] font-medium fill-sky-600 dark:fill-sky-300">up →: one POST, its body held open</text>

      <text x="340" y="236" text-anchor="middle" class="text-[14px] fill-(--ui-text-muted)">Two one-way streams make one two-way connection.</text>
    </svg>
  </SplitStreamFigure>
</template>

<style scoped>
.ss-chip {
  transform-box: view-box;
}

@media (prefers-reduced-motion: no-preference) {
  .ss-chip {
    animation: ss-travel calc(v-bind(SECONDS) * 1s) linear infinite;
    animation-delay: calc(var(--i) * v-bind(SECONDS) * -1s / 2);
  }
}

@keyframes ss-travel {
  0% {
    transform: translateX(0);
    opacity: 0;
  }
  8%,
  90% {
    opacity: 1;
  }
  100% {
    transform: translateX(var(--travel));
    opacity: 0;
  }
}
</style>
