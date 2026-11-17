<script setup lang="ts">
import { createTimeline } from 'animejs'

// The checks a connection passes, left to right, to move from batch mode to stream mode.
// Any "no" keeps it in batch mode. A packet runs the checks twice: once as Chrome on HTTP/2,
// which gets through, and once as Safari, which stops at the first check.
const Y = 72
const H = 56
const MID = Y + H / 2
const boxes = [
  { x: 4, w: 104, lines: ['connect', 'in batch mode'], kind: 'start' },
  { x: 134, w: 120, lines: ['browser streams', 'a request body?'], note: 'Chromium today', kind: 'check' },
  { x: 280, w: 120, lines: ['site on HTTP/2', 'or newer?'], kind: 'check' },
  { x: 426, w: 120, lines: ['probe answered', 'within 2 s?'], note: 'tests the network', kind: 'check' },
  { x: 572, w: 104, lines: ['stream mode', 'one long POST'], kind: 'end' },
] as const
const centre = boxes.map((box) => box.x + box.w / 2)
const BATCH = { x: 134, y: 196, w: 412, h: 54 }
const runs = ['Chrome on HTTP/2', 'Safari']

const paused = ref(false)
const art = ref<SVGElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
  const hop = (from: number, to: number) => ({ translateX: [centre[from]! - centre[0]!, centre[to]! - centre[0]!], duration: 520 })

  // Chrome on HTTP/2: three yes answers, then stream mode.
  timeline
    .add('.dc-packet', { translateX: 0, translateY: 0, duration: 1 }, 0)
    .add(['.dc-packet', '.dc-tag-0'], { opacity: [0, 1], duration: 250 }, 200)
  for (const gate of [1, 2, 3]) {
    const at = 450 + (gate - 1) * 760
    timeline
      .add('.dc-packet', hop(gate - 1, gate), at)
      .add(`.dc-ok-${gate}`, { opacity: [0, 1], scale: [0.6, 1], duration: 260, ease: 'outBack' }, at + 480)
      .add(`.dc-gate-${gate}`, { opacity: [0, 0.9, 0.25], duration: 600 }, at + 480)
  }
  timeline
    .add('.dc-packet', hop(3, 4), 2730)
    .add('.dc-end-glow', { opacity: [0, 1, 0.4], duration: 700 }, 3200)
    .add(['.dc-packet', '.dc-tag-0'], { opacity: 0, duration: 250 }, 3400)
    .add(['.dc-ok-1', '.dc-ok-2', '.dc-ok-3', '.dc-gate-1', '.dc-gate-2', '.dc-gate-3', '.dc-end-glow'], { opacity: 0, duration: 350 }, 4600)

  // Safari: no at the first check, so it drops into batch mode.
  return timeline
    .add('.dc-packet', { translateX: 0, translateY: 0, duration: 1 }, 5000)
    .add(['.dc-packet', '.dc-tag-1'], { opacity: [0, 1], duration: 250 }, 5100)
    .add('.dc-packet', hop(0, 1), 5350)
    .add('.dc-no-1', { opacity: [0, 1], scale: [0.6, 1], duration: 260, ease: 'outBack' }, 5830)
    .add('.dc-miss', { opacity: [0, 0.9, 0.25], duration: 600 }, 5830)
    .add('.dc-packet', { translateY: [0, BATCH.y + BATCH.h / 2 - MID], duration: 620, ease: 'inQuad' }, 6250)
    .add('.dc-tag-1', { opacity: 0, duration: 200 }, 6250)
    .add('.dc-batch-glow', { opacity: [0, 1, 0.4], duration: 700 }, 6850)
    .add('.dc-packet', { opacity: 0, duration: 250 }, 7050)
    .add(['.dc-no-1', '.dc-miss', '.dc-batch-glow'], { opacity: 0, duration: 350 }, 8800)
}, { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="Every connection starts in batch mode. It moves to stream mode only when the browser, the protocol and the network all allow it. Any “no” keeps it in batch mode, which works everywhere.">
    <svg ref="art" viewBox="0 0 680 262" class="w-full" role="img" aria-label="A flow from left to right. Connect in batch mode. Can the browser stream a request body? Is the site on HTTP/2 or newer? Is the probe answered within 2 seconds? Three yes answers lead to stream mode. Any no leads to staying in batch mode.">
      <!-- yes: on to the next check -->
      <g v-for="index in 4" :key="`yes-${index}`">
        <line :x1="boxes[index - 1]!.x + boxes[index - 1]!.w" :y1="MID" :x2="boxes[index]!.x" :y2="MID" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />
        <text v-if="index > 1" :x="(boxes[index - 1]!.x + boxes[index - 1]!.w + boxes[index]!.x) / 2" :y="MID - 8" text-anchor="middle" class="font-mono text-[10px] fill-emerald-600 dark:fill-emerald-300">yes</text>
      </g>

      <!-- no: down into batch mode -->
      <g v-for="gate in [1, 2, 3]" :key="`no-${gate}`">
        <line :x1="centre[gate]" :y1="Y + H" :x2="centre[gate]" :y2="BATCH.y" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 4" class="opacity-60" />
        <text :x="centre[gate]! + 7" :y="Y + H + 36" class="font-mono text-[10px] fill-red-600 dark:fill-red-300">no</text>
      </g>

      <!-- the boxes -->
      <g v-for="(box, index) in boxes" :key="box.x">
        <text v-if="'note' in box" :x="box.x + box.w / 2" :y="Y - 12" text-anchor="middle" class="font-mono text-[10px] fill-(--ui-text-muted)">{{ box.note }}</text>
        <rect
          :x="box.x" :y="Y" :width="box.w" :height="H"
          :fill="box.kind === 'end' ? '#e14300' : undefined"
          :stroke="box.kind === 'end' ? '#ffb36b' : undefined"
          :class="box.kind === 'end' ? '' : box.kind === 'check' ? 'fill-(--art-top) stroke-orange-400/50' : 'fill-(--art-top) stroke-(--art-line)'"
        />
        <rect v-if="box.kind === 'check'" :x="box.x" :y="Y" :width="box.w" :height="H" fill="none" stroke="#34d399" stroke-width="2" :class="`dc-gate-${index}`" class="opacity-0" />
        <text
          v-for="(line, row) in box.lines" :key="line"
          :x="box.x + box.w / 2" :y="Y + 24 + row * 16" text-anchor="middle"
          :class="box.kind === 'end' ? (row ? 'font-mono text-[10.5px] fill-orange-100' : 'text-[13px] font-semibold fill-white') : 'text-[12px] fill-(--ui-text-highlighted)'"
        >{{ line }}</text>
        <text v-if="box.kind === 'check'" :x="box.x + box.w - 9" :y="Y + 14" text-anchor="middle" :class="`dc-ok-${index}`" class="dc-mark font-mono text-[12px] font-bold opacity-0 fill-emerald-500">✓</text>
      </g>
      <rect :x="boxes[1].x" :y="Y" :width="boxes[1].w" :height="H" fill="none" stroke="#f87171" stroke-width="2" class="dc-miss opacity-0" />
      <text :x="boxes[1].x + boxes[1].w - 9" :y="Y + 14" text-anchor="middle" class="dc-no-1 dc-mark font-mono text-[12px] font-bold opacity-0 fill-red-500">✕</text>
      <rect :x="boxes[4].x - 4" :y="Y - 4" :width="boxes[4].w + 8" :height="H + 8" fill="none" stroke="#ff8a3d" stroke-width="2" class="dc-end-glow ss-glow-down opacity-0" />

      <!-- batch mode, under every check -->
      <rect :x="BATCH.x" :y="BATCH.y" :width="BATCH.w" :height="BATCH.h" class="fill-sky-500/10 stroke-sky-500/60" />
      <rect :x="BATCH.x - 4" :y="BATCH.y - 4" :width="BATCH.w + 8" :height="BATCH.h + 8" fill="none" stroke="#38bdf8" stroke-width="2" class="dc-batch-glow ss-glow-up opacity-0" />
      <text :x="BATCH.x + BATCH.w / 2" :y="BATCH.y + 23" text-anchor="middle" class="text-[13px] font-semibold fill-sky-700 dark:fill-sky-200">stay in batch mode</text>
      <text :x="BATCH.x + BATCH.w / 2" :y="BATCH.y + 41" text-anchor="middle" class="font-mono text-[10.5px] fill-(--ui-text-muted)">works everywhere · a failed probe counts for 10 min</text>

      <!-- the connection that runs the checks -->
      <g :transform="`translate(${centre[0]} ${MID})`">
        <g class="dc-packet opacity-0">
          <rect x="-6" y="-6" width="12" height="12" fill="#ffb36b" class="ss-glow-down" />
          <text v-for="(run, index) in runs" :key="run" y="-14" text-anchor="middle" :class="`dc-tag-${index}`" class="font-mono text-[10.5px] opacity-0 fill-orange-700 dark:fill-orange-200">{{ run }}</text>
        </g>
      </g>
    </svg>
  </SplitStreamFigure>
</template>

<style scoped>
.dc-mark {
  transform-box: fill-box;
  transform-origin: center;
}
</style>
