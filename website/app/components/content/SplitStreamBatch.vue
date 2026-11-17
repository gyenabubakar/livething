<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

// Batch mode: one POST in flight. Messages sent meanwhile wait, and the next POST takes them
// all. The server's log fills in order as each POST lands.
const queued = ['react', 'start-typing', 'send-message']
const ran = ['send-message', ...queued]
const BROWSER = { x: 8, y: 20, w: 150, h: 206 }
const SERVER = { x: 522, y: 20, w: 150, h: 206 }
const POST_Y = 52
const ACK_Y = 176
const posts = [
  { name: 'POST 1', lines: ['send-message'], w: 128 },
  { name: 'POST 2', lines: queued, w: 140 },
]
const FROM = BROWSER.x + BROWSER.w + 8
const travel = (w: number) => SERVER.x - 8 - w - FROM

const paused = ref(false)
const art = ref<SVGElement>()

useIllustration(art, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
  // POST 1 leaves with the first message. Three more are sent while it is in flight.
  .add('.bt-post-0', { opacity: [0, 1], duration: 250 }, 200)
  .add('.bt-post-0', { translateX: [0, travel(posts[0]!.w)], duration: 1500 }, 450)
  .add('.bt-queue', { opacity: [0, 1], translateX: [-8, 0], duration: 300, delay: stagger(380) }, 700)
  .add('.bt-post-0', { opacity: 0, duration: 200 }, 1950)
  .add('.bt-ran-0', { opacity: [0, 1], duration: 250 }, 1950)
  .add('.bt-ack-0', { translateX: [0, -(SERVER.x - FROM - 70)], opacity: [0, 1, 1, 0], duration: 1100 }, 2050)

  // The answer is in, so POST 2 takes the whole queue.
  .add('.bt-queue', { opacity: 0, translateX: 12, duration: 300, delay: stagger(60) }, 3150)
  .add('.bt-post-1', { opacity: [0, 1], duration: 250 }, 3250)
  .add('.bt-post-1', { translateX: [0, travel(posts[1]!.w)], duration: 1500 }, 3450)
  .add('.bt-post-1', { opacity: 0, duration: 200 }, 4950)
  .add(['.bt-ran-1', '.bt-ran-2', '.bt-ran-3'], { opacity: [0, 1], duration: 250, delay: stagger(140) }, 4950)
  .add('.bt-ack-1', { translateX: [0, -(SERVER.x - FROM - 70)], opacity: [0, 1, 1, 0], duration: 1100 }, 5150)
  .add('.bt-total', { opacity: [0.4, 1], duration: 400 }, 6250)

  .add(['.bt-ran', '.bt-total'], { opacity: (_: unknown, i: number, total: number) => (i === total - 1 ? 0.4 : 0), duration: 400 }, 8400)
  .add('.bt-post', { translateX: 0, duration: 1 }, 8800), { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="Batch mode keeps one POST in flight. The messages you send meanwhile wait, and the next POST carries all of them, up to 255 messages or the server's maxPostBytes size limit. 204 is the server's answer: done, nothing to send back.">
    <svg ref="art" viewBox="0 0 680 262" class="w-full" role="img" aria-label="The first POST carries one message to the server. While it is in flight, three more messages wait in the browser. When the server answers 204, the second POST carries all three. The server runs all four in order.">
      <!-- the browser and its queue -->
      <rect v-bind="BROWSER" :width="BROWSER.w" :height="BROWSER.h" class="fill-(--art-top) stroke-(--art-line)" />
      <text :x="BROWSER.x + 14" :y="BROWSER.y + 24" class="font-mono text-[12px] fill-(--ui-text-highlighted)">browser</text>
      <text :x="BROWSER.x + 14" :y="BROWSER.y + 96" class="font-mono text-[10px] uppercase tracking-widest fill-(--ui-text-muted)">waiting</text>
      <rect v-for="index in queued.length" :key="`slot-${index}`" :x="BROWSER.x + 12" :y="BROWSER.y + 106 + (index - 1) * 30" :width="BROWSER.w - 24" height="22" fill="none" class="stroke-(--art-line)" stroke-dasharray="2 3" />
      <g v-for="(label, index) in queued" :key="label" class="bt-queue rm-show opacity-0">
        <rect :x="BROWSER.x + 12" :y="BROWSER.y + 106 + index * 30" :width="BROWSER.w - 24" height="22" class="fill-sky-500/15 stroke-sky-500/70" />
        <text :x="BROWSER.x + 22" :y="BROWSER.y + 121 + index * 30" class="font-mono text-[11px] fill-sky-700 dark:fill-sky-200">{{ label }}</text>
      </g>

      <!-- the server runs each message in order -->
      <rect v-bind="SERVER" :width="SERVER.w" :height="SERVER.h" class="fill-(--art-top) stroke-orange-400/60" />
      <g :transform="`translate(${SERVER.x + 14} ${SERVER.y + 10})`">
        <AppLogoMark width="13" height="18" />
      </g>
      <text :x="SERVER.x + 34" :y="SERVER.y + 24" class="font-mono text-[12px] fill-(--ui-text-highlighted)">server</text>
      <text :x="SERVER.x + 14" :y="SERVER.y + 56" class="font-mono text-[10px] uppercase tracking-widest fill-(--ui-text-muted)">ran, in order</text>
      <text v-for="(label, index) in ran" :key="`ran-${index}`" :x="SERVER.x + 14" :y="SERVER.y + 80 + index * 22" :class="`bt-ran-${index}`" class="bt-ran rm-show font-mono text-[11px] opacity-0 fill-orange-700 dark:fill-orange-200">{{ index + 1 }} · {{ label }}</text>

      <!-- the lanes: data POSTs above, their answers below -->
      <line :x1="FROM" :y1="POST_Y + 22" :x2="SERVER.x - 8" :y2="POST_Y + 22" class="stroke-(--art-line)" stroke-dasharray="2 5" />
      <line :x1="FROM" :y1="ACK_Y" :x2="SERVER.x - 8" :y2="ACK_Y" class="stroke-(--art-line)" stroke-dasharray="2 5" />
      <text :x="(FROM + SERVER.x) / 2" :y="POST_Y - 10" text-anchor="middle" class="font-mono text-[10px] fill-(--ui-text-muted)">one data POST in flight at a time</text>

      <g v-for="(post, index) in posts" :key="post.name" :class="`bt-post-${index}`" class="bt-post ss-glow-up opacity-0" :style="index === 0 ? undefined : undefined">
        <rect :x="FROM" :y="POST_Y" :width="post.w" :height="26 + post.lines.length * 16" class="fill-sky-500 dark:fill-sky-400" />
        <text :x="FROM + 10" :y="POST_Y + 16" class="font-mono text-[10px] font-semibold uppercase tracking-widest fill-white/85 dark:fill-sky-950/80">{{ post.name }}</text>
        <text v-for="(line, row) in post.lines" :key="line" :x="FROM + 10" :y="POST_Y + 34 + row * 16" class="font-mono text-[11px] fill-white dark:fill-sky-950">{{ line }}</text>
      </g>
      <g class="bt-post-still hidden motion-reduce:inline" :transform="`translate(${travel(posts[0]!.w) / 2} 0)`">
        <rect :x="FROM" :y="POST_Y" :width="posts[0]!.w" height="42" class="fill-sky-500 dark:fill-sky-400 ss-glow-up" />
        <text :x="FROM + 10" :y="POST_Y + 16" class="font-mono text-[10px] font-semibold uppercase tracking-widest fill-white/85 dark:fill-sky-950/80">POST 1</text>
        <text :x="FROM + 10" :y="POST_Y + 34" class="font-mono text-[11px] fill-white dark:fill-sky-950">send-message</text>
      </g>

      <g v-for="index in 2" :key="`ack-${index}`" :class="`bt-ack-${index - 1}`" class="opacity-0">
        <rect :x="SERVER.x - 70" :y="ACK_Y - 11" width="62" height="22" class="fill-(--ui-bg) stroke-(--ui-text-muted)/60" />
        <text :x="SERVER.x - 39" :y="ACK_Y + 4" text-anchor="middle" class="font-mono text-[11px] fill-(--ui-text-muted)">← 204</text>
      </g>

      <text x="340" y="252" text-anchor="middle" class="bt-total font-mono text-[12px] opacity-40 fill-(--ui-text-toned) motion-reduce:opacity-100">4 messages · 2 data POSTs</text>
    </svg>
  </SplitStreamFigure>
</template>
