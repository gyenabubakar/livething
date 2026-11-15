<script setup lang="ts">
// The checks a connection passes, left to right, to move from batch mode to stream mode.
// Any "no" keeps it in batch mode.
const W = 120
const H = 64
const Y = 60
const steps = [
  { x: 6, lines: ['Connect', 'in batch mode'], kind: 'start' },
  { x: 137, lines: ['Browser can', 'stream a body?'], note: 'Chromium only', kind: 'check' },
  { x: 268, lines: ['Site on HTTP/2', 'or newer?'], kind: 'check' },
  { x: 399, lines: ['Probe answered', 'within 2 s?'], note: 'tests the network', kind: 'check' },
  { x: 530, lines: ['Stream mode'], note: 'one long POST', kind: 'end' },
] as const
const BATCH = { x: 137, y: 184, w: 382, h: 60 }
</script>

<template>
  <SplitStreamFigure animated caption="An arrow to the right means yes. Every connection starts in batch mode. It moves to stream mode only when the browser, the protocol and the network all allow it. Any “no” keeps it in batch mode, which works everywhere.">
    <svg viewBox="0 0 656 256" class="w-full" role="img" aria-label="A flow from left to right. Connect in batch mode. Can the browser stream a request body? Is the site on HTTP/2 or newer? Is the probe answered within 2 seconds? Three yes answers lead to stream mode. Any no leads to staying in batch mode.">
      <defs>
        <marker id="ss-dec-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" class="fill-(--ui-text-muted)" />
        </marker>
      </defs>

      <!-- yes arrows -->
      <g v-for="index in 4" :key="`yes${index}`">
        <line :x1="steps[index - 1]!.x + W" :y1="Y + H / 2" :x2="steps[index]!.x - 2" :y2="Y + H / 2" stroke="#ff8a3d" stroke-width="2" class="dash-flow" marker-end="url(#ss-dec-arrow)" />
      </g>

      <!-- boxes -->
      <g v-for="step in steps" :key="step.x">
        <rect
          :x="step.x" :y="Y" :width="W" :height="H" rx="10"
          :class="step.kind === 'end' ? 'fill-orange-500 stroke-orange-300' : step.kind === 'start' ? 'fill-(--ui-bg) stroke-(--art-line)' : 'fill-orange-500/[0.06] stroke-orange-400/60'"
        />
        <text
          v-for="(line, row) in step.lines" :key="line"
          :x="step.x + W / 2" :y="Y + (step.lines.length === 1 ? H / 2 + 5.5 : 27 + row * 17)"
          text-anchor="middle"
          :class="step.kind === 'end' ? 'text-[15px] font-semibold fill-white' : 'text-[13px] font-medium fill-(--ui-text-highlighted)'"
        >{{ line }}</text>
        <text v-if="'note' in step" :x="step.x + W / 2" :y="Y - 10" text-anchor="middle" class="text-[12.5px] fill-(--ui-text-muted)">{{ step.note }}</text>
      </g>

      <!-- no arrows into batch mode -->
      <g v-for="index in [1, 2, 3]" :key="`no${index}`">
        <line :x1="steps[index]!.x + W / 2" :y1="Y + H" :x2="steps[index]!.x + W / 2" :y2="BATCH.y - 2" class="stroke-(--ui-text-muted)/60" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ss-dec-arrow)" />
        <text :x="steps[index]!.x + W / 2 + 8" :y="Y + H + 32" class="text-[12.5px] font-medium fill-red-600 dark:fill-red-400">no</text>
      </g>
      <rect :x="BATCH.x" :y="BATCH.y" :width="BATCH.w" :height="BATCH.h" rx="10" class="fill-sky-500/10 stroke-sky-500/60" />
      <text :x="BATCH.x + BATCH.w / 2" :y="BATCH.y + 24" text-anchor="middle" class="text-[15px] font-semibold fill-sky-700 dark:fill-sky-200">Stay in batch mode</text>
      <text :x="BATCH.x + BATCH.w / 2" :y="BATCH.y + 44" text-anchor="middle" class="text-[12.5px] fill-(--ui-text-muted)">works everywhere · a failed probe counts for 10 min</text>
    </svg>
  </SplitStreamFigure>
</template>
