<script setup lang="ts">
// The bytes of a POST body: frames back to back. Each frame is 1 byte of type, 4 bytes of
// length (big-endian), then the message.
const text = '["clear-history",null,null]'
const hex = (value: number) =>
  [24, 16, 8, 0].map((shift) => ((value >> shift) & 255).toString(16).padStart(2, '0'))
const pictureBytes = 65_545

const CELL = 38
const H = 44
const X = 20
const MESSAGE_W = 250
const frames = [
  { y: 58, type: '00', length: text.length, color: 'orange', message: 'the message: JSON text' },
  { y: 160, type: '01', length: pictureBytes, color: 'sky', message: 'the message: raw bytes' },
] as const
</script>

<template>
  <SplitStreamFigure caption="A POST body is frames back to back. Each frame is one byte for its type, four bytes for its length, then the message. The bytes are shown in hex. The long POST of stream mode uses the same frames, plus three of its own.">
    <svg viewBox="0 0 680 340" class="w-full" role="img" :aria-label="`Two frames in one POST body. The first has type 0, text, a length of ${text.length} bytes, and the JSON message. The second has type 1, binary, a length of ${pictureBytes} bytes, and the bytes of a binary message.`">
      <text :x="X" y="34" class="text-[12.5px] font-medium uppercase tracking-wider fill-(--ui-text-muted)">One POST body, two frames · bytes in hex</text>

      <g v-for="(frame, row) in frames" :key="frame.type">
        <!-- type byte, four length bytes, then the message -->
        <rect :x="X" :y="frame.y" :width="CELL" :height="H" :class="frame.color === 'orange' ? 'fill-orange-500 stroke-(--art-top)' : 'fill-sky-500 stroke-(--art-top) dark:fill-sky-400'" />
        <text :x="X + CELL / 2" :y="frame.y + 27" text-anchor="middle" :class="frame.color === 'orange' ? 'font-mono text-[14px] fill-white' : 'font-mono text-[14px] fill-white dark:fill-sky-950'">{{ frame.type }}</text>
        <g v-for="(byte, index) in hex(frame.length)" :key="index">
          <rect :x="X + CELL * (index + 1)" :y="frame.y" :width="CELL" :height="H" :class="frame.color === 'orange' ? 'fill-orange-500/20 stroke-(--art-top)' : 'fill-sky-500/20 stroke-(--art-top)'" />
          <text :x="X + CELL * (index + 1.5)" :y="frame.y + 27" text-anchor="middle" :class="frame.color === 'orange' ? 'font-mono text-[14px] fill-orange-800 dark:fill-orange-100' : 'font-mono text-[14px] fill-sky-800 dark:fill-sky-100'">{{ byte }}</text>
        </g>
        <rect :x="X + CELL * 5" :y="frame.y" :width="MESSAGE_W" :height="H" class="fill-(--ui-bg) stroke-(--art-line)" />
        <text v-if="row === 0" :x="X + CELL * 5 + MESSAGE_W / 2" :y="frame.y + 27" text-anchor="middle" class="font-mono text-[12.5px] fill-(--ui-text-highlighted)">{{ text }}</text>
        <g v-else :transform="`translate(${X + CELL * 5} ${frame.y})`">
          <rect v-for="index in 20" :key="index" :x="10 + (index - 1) * 11.6" :y="12 + (index % 3) * 7" width="8" height="9" rx="1" class="fill-sky-500/30" />
        </g>

        <!-- braces under each part -->
        <g class="text-[12.5px] fill-(--ui-text-muted)">
          <path :d="`M${X} ${frame.y + H + 8} v6 h${CELL} v-6`" class="fill-none stroke-(--ui-text-muted)/60" />
          <text :x="X + CELL / 2" :y="frame.y + H + 30" text-anchor="middle">type: {{ row }}</text>
          <path :d="`M${X + CELL} ${frame.y + H + 8} v6 h${CELL * 4} v-6`" class="fill-none stroke-(--ui-text-muted)/60" />
          <text :x="X + CELL * 3" :y="frame.y + H + 30" text-anchor="middle">length: {{ frame.length.toLocaleString('en-US') }} bytes</text>
          <path :d="`M${X + CELL * 5} ${frame.y + H + 8} v6 h${MESSAGE_W} v-6`" class="fill-none stroke-(--ui-text-muted)/60" />
          <text :x="X + CELL * 5 + MESSAGE_W / 2" :y="frame.y + H + 30" text-anchor="middle">{{ frame.message }}</text>
        </g>
      </g>

      <!-- the frame types -->
      <g :transform="`translate(${X} 270)`">
        <text y="0" class="text-[12.5px] font-medium uppercase tracking-wider fill-(--ui-text-muted)">Types</text>
        <text x="66" y="0" class="text-[13px] fill-(--ui-text-toned)"><tspan class="font-mono">0</tspan> text · <tspan class="font-mono">1</tspan> binary</text>
        <text x="66" y="22" class="text-[13px] fill-(--ui-text-toned)">Long POST only: <tspan class="font-mono">2</tspan> probe · <tspan class="font-mono">3</tspan> start, the number of its first message</text>
        <text x="66" y="44" class="text-[13px] fill-(--ui-text-toned)">Long POST only: <tspan class="font-mono">4</tspan> close, after the last message</text>
      </g>
    </svg>
  </SplitStreamFigure>
</template>
