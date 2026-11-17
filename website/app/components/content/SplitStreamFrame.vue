<script setup lang="ts">
import { createTimeline } from 'animejs'

// The bytes of a POST body: frames back to back. Each frame is 1 byte of type, 4 bytes of
// length (big-endian), then the message. A read cursor walks the parts in order, the way the
// server reads them.
const text = '["clear-history",null,null]'
const hex = (value: number) =>
  [24, 16, 8, 0].map((shift) => ((value >> shift) & 255).toString(16).padStart(2, '0'))
const pictureBytes = 65_545

const CELL = 38
const H = 42
const X = 20
const MESSAGE_W = 258
const frames = [
  { y: 52, type: '00', length: text.length, tone: 'text', message: 'the message: JSON text' },
  { y: 150, type: '01', length: pictureBytes, tone: 'binary', message: 'the message: raw bytes' },
] as const
const parts = frames.flatMap((frame) => [
  { x: X, y: frame.y, w: CELL },
  { x: X + CELL, y: frame.y, w: CELL * 4 },
  { x: X + CELL * 5, y: frame.y, w: MESSAGE_W },
])

const paused = ref(false)
const art = ref<SVGElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, loopDelay: 600, defaults: { ease: 'inOutQuad' } })
    .add('.fr-cursor', { opacity: [0, 1], duration: 250 }, 0)
  parts.forEach((part, index) => {
    timeline.add('.fr-cursor', { x: part.x - 3, y: part.y - 3, width: part.w + 6, duration: index ? 420 : 1 }, 200 + index * 900)
  })
  return timeline.add('.fr-cursor', { opacity: 0, duration: 300 }, 200 + parts.length * 900 + 400)
}, { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="A POST body is frames back to back. Each frame is one byte for its type, four bytes for its length, then the message. The bytes are shown in hex. The long POST of stream mode uses the same frames, plus three of its own.">
    <svg ref="art" viewBox="0 0 680 330" class="w-full" role="img" :aria-label="`Two frames in one POST body. The first has type 0, text, a length of ${text.length} bytes, and the JSON message. The second has type 1, binary, a length of ${pictureBytes} bytes, and the bytes of a binary message.`">
      <text :x="X" y="28" class="font-mono text-[10.5px] uppercase tracking-widest fill-(--ui-text-muted)">one POST body · two frames · bytes in hex</text>

      <g v-for="(frame, row) in frames" :key="frame.type">
        <!-- type byte, four length bytes, then the message -->
        <rect :x="X" :y="frame.y" :width="CELL" :height="H" :class="frame.tone === 'text' ? 'fill-orange-500 stroke-(--ui-bg)' : 'fill-sky-500 stroke-(--ui-bg) dark:fill-sky-400'" />
        <text :x="X + CELL / 2" :y="frame.y + 26" text-anchor="middle" class="font-mono text-[14px]" :class="frame.tone === 'text' ? 'fill-white' : 'fill-white dark:fill-sky-950'">{{ frame.type }}</text>
        <g v-for="(byte, index) in hex(frame.length)" :key="index">
          <rect :x="X + CELL * (index + 1)" :y="frame.y" :width="CELL" :height="H" :class="frame.tone === 'text' ? 'fill-orange-500/15 stroke-orange-400/40' : 'fill-sky-500/15 stroke-sky-500/40'" />
          <text :x="X + CELL * (index + 1.5)" :y="frame.y + 26" text-anchor="middle" class="font-mono text-[14px]" :class="frame.tone === 'text' ? 'fill-orange-800 dark:fill-orange-100' : 'fill-sky-800 dark:fill-sky-100'">{{ byte }}</text>
        </g>
        <rect :x="X + CELL * 5" :y="frame.y" :width="MESSAGE_W" :height="H" class="fill-(--art-top) stroke-(--art-line)" />
        <text v-if="row === 0" :x="X + CELL * 5 + MESSAGE_W / 2" :y="frame.y + 26" text-anchor="middle" class="font-mono text-[12px] fill-(--ui-text-highlighted)">{{ text }}</text>
        <g v-else :transform="`translate(${X + CELL * 5} ${frame.y})`">
          <rect v-for="index in 21" :key="index" :x="10 + (index - 1) * 11.6" :y="11 + (index % 3) * 7" width="8" height="8" class="fill-sky-500/35" />
        </g>

        <!-- what each part is -->
        <g class="font-mono text-[11px] fill-(--ui-text-muted)">
          <path :d="`M${X} ${frame.y + H + 7} v5 h${CELL} v-5`" class="fill-none stroke-(--art-line)" />
          <text :x="X + CELL / 2" :y="frame.y + H + 27" text-anchor="middle">type {{ row }}</text>
          <path :d="`M${X + CELL} ${frame.y + H + 7} v5 h${CELL * 4} v-5`" class="fill-none stroke-(--art-line)" />
          <text :x="X + CELL * 3" :y="frame.y + H + 27" text-anchor="middle">length: {{ frame.length.toLocaleString('en-US') }} bytes</text>
          <path :d="`M${X + CELL * 5} ${frame.y + H + 7} v5 h${MESSAGE_W} v-5`" class="fill-none stroke-(--art-line)" />
          <text :x="X + CELL * 5 + MESSAGE_W / 2" :y="frame.y + H + 27" text-anchor="middle">{{ frame.message }}</text>
        </g>
      </g>

      <!-- the server's read cursor -->
      <rect class="fr-cursor ss-glow-down opacity-0" :x="parts[0]!.x - 3" :y="parts[0]!.y - 3" :width="parts[0]!.w + 6" :height="H + 6" fill="none" stroke="#ff8a3d" stroke-width="2" />
      <text x="660" y="28" text-anchor="end" class="font-mono text-[10.5px] fill-orange-600 dark:fill-orange-300">the server reads in order →</text>

      <!-- the frame types -->
      <g :transform="`translate(${X} 262)`" class="font-mono text-[11.5px]">
        <text y="0" class="text-[10.5px] uppercase tracking-widest fill-(--ui-text-muted)">types</text>
        <text x="62" y="0" class="fill-(--ui-text-toned)">0 text · 1 binary</text>
        <text x="62" y="21" class="fill-(--ui-text-toned)">long POST only: 2 probe · 3 start, the number of its first message</text>
        <text x="62" y="42" class="fill-(--ui-text-toned)">long POST only: 4 close, after the last message</text>
      </g>
    </svg>
  </SplitStreamFigure>
</template>
