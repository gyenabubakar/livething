<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

// A browser on the left, the server on the right, three lanes between them on
// the ground. A proxy wall rises on the WebSocket lane; the client falls back
// to the two http() lanes.
const O = { ox: 320, oy: 196 }
const CLIENT = { x: -250, w: 60 }
const SERVER = { x: 130, w: 120 }
const DEPTH = 140
const START = CLIENT.x + CLIENT.w
const END = SERVER.x
const LANE = { ws: -46, events: 14, posts: 46 }
const WALL = { x: -40, w: 12, y: -80, d: 68, h: 66 }

const p = (x: number, y: number, z = 0) => iso(O, x, y, z)
const line = (y: number, from: number, to: number) => {
  const [x1, y1] = p(from, y)
  const [x2, y2] = p(to, y)
  return { x1, y1, x2, y2 }
}

const client = isoBox(O, CLIENT.x, -DEPTH / 2, 0, CLIENT.w, DEPTH, 14)
const clientLogo = isoTopMatrix(O, CLIENT.x + CLIENT.w / 2 - 20, -20, 14)
const serverSlabs = [0, 34].map(z => isoBox(O, SERVER.x, -DEPTH / 2, z, SERVER.w, DEPTH, 20))
const serverTop = isoBox(O, SERVER.x, -DEPTH / 2, 68, SERVER.w, DEPTH, 24)
const serverLogo = isoTopMatrix(O, SERVER.x + SERVER.w / 2 - 24, -34, 92)
const wall = isoBox(O, WALL.x, WALL.y, 0, WALL.w, WALL.d, WALL.h)

const lanes = {
  ws: line(LANE.ws, START, END),
  wsBlocked: line(LANE.ws, START, WALL.x),
  // Drawn server to client, so the dashes flow toward the browser.
  events: line(LANE.events, END, START),
  posts: line(LANE.posts, START, END),
}
const labels = [
  { text: 'websocket()', y: LANE.ws },
  { text: 'events', y: LANE.events },
  { text: 'POSTs', y: LANE.posts },
].map(label => ({ ...label, matrix: isoTopMatrix(O, START + 26, label.y - 9, 0) }))

const hit = p(WALL.x, LANE.ws, 6)
const errorAt = p(WALL.x + WALL.w / 2, WALL.y + WALL.d / 2, WALL.h + 16)
const EVENTS = 5
const BATCH = 3

const art = ref<HTMLElement>()

useIllustration(art, () => {
  const tween = (y: number, from: number, to: number) => {
    const a = p(from, y)
    const b = p(to, y)
    return { cx: [a[0], b[0]], cy: [a[1], b[1]] }
  }
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
    .add('.fb-wall', { opacity: [0, 1], translateY: [36, 0], duration: 700, ease: 'outBack' }, 0)

    .add(['.fb-ws-live', '.fb-ws-on', '.fb-step-0'], { opacity: [0, 1], duration: 250 }, 800)
    .add('.fb-handshake', { ...tween(LANE.ws, START, WALL.x), opacity: [0, 1, 1], duration: 900, ease: 'inQuad' }, 850)
    .add('.fb-handshake', { opacity: 0, duration: 120 }, 1750)
    .add('.fb-burst', { r: [6, 40], opacity: [0.9, 0], duration: 700, ease: 'outQuad' }, 1750)
    .add('.fb-flash', { opacity: [0, 0.7, 0], duration: 600 }, 1750)
    .add(['.fb-ws-live', '.fb-ws-on'], { opacity: 0, duration: 200 }, 1800)
    .add(['.fb-ws-dead', '.fb-ws-note', '.fb-step-1'], { opacity: [0, 1], duration: 250 }, 1850)
    .add('.fb-error', { opacity: [0, 1], translateY: [8, 0], duration: 400, ease: 'outBack' }, 1850)
    .add('.fb-ws-strike', { opacity: [0, 1], scaleX: [0, 1], duration: 400 }, 1900)

    .add(['.fb-http-on', '.fb-step-2'], { opacity: [0, 1], duration: 250 }, 2500)
    .add('.fb-open', { ...tween(LANE.events, START, END), opacity: [0, 1, 1], duration: 800 }, 2550)
    .add('.fb-open', { opacity: 0, duration: 150 }, 3350)
    .add(['.fb-events-live', '.fb-step-3'], { opacity: [0, 1], duration: 300 }, 3400)
    .add('.fb-event', { ...tween(LANE.events, END, START), opacity: [0, 1, 1, 0], duration: 1000, ease: 'linear', delay: stagger(420) }, 3500)
    .add('.fb-posts-live', { opacity: [0, 1], duration: 300 }, 3800)

  for (const [batch, at] of [3900, 5300].entries()) {
    timeline.add(`.fb-post-${batch}`, {
      cx: (_: unknown, i: number) => [p(START - i * 12, LANE.posts)[0], p(END - i * 12, LANE.posts)[0]],
      cy: (_: unknown, i: number) => [p(START - i * 12, LANE.posts)[1], p(END - i * 12, LANE.posts)[1]],
      opacity: [0, 1, 1, 0],
      duration: 1100,
    }, at)
  }

  return timeline.add([
    '.fb-wall', '.fb-error', '.fb-ws-dead', '.fb-ws-note', '.fb-ws-strike', '.fb-http-on',
    '.fb-events-live', '.fb-posts-live', '.fb-step',
  ], { opacity: 0, duration: 400 }, 8200)
    .add('.fb-wall', { translateY: 36, duration: 1 }, 8650)
})
</script>

<template>
  <LandingFeatureCell :link :link-label centered>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div class="absolute inset-0 bg-[radial-gradient(40%_55%_at_50%_55%,rgb(244_97_15/0.10),transparent)]" aria-hidden="true" />
      <div ref="art" class="relative mx-auto aspect-[8/5] w-full max-w-3xl px-4 pb-8">
        <svg viewBox="0 0 640 400" class="size-full" role="img" aria-label="A proxy blocks the WebSocket handshake with close code 1006, so the client falls back to http(): server-sent events come down and POSTs go up, with the same app code">
          <defs>
            <linearGradient id="fb-edge" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stop-color="#ffb36b" />
              <stop offset="1" stop-color="#e14300" />
            </linearGradient>
            <pattern id="fb-hazard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="10" fill="#ef4444" fill-opacity="0.55" />
            </pattern>
          </defs>

          <!-- the lanes lie on the ground; their names lie flat beside them -->
          <line v-bind="lanes.ws" class="stroke-(--art-line)" stroke-width="2" stroke-dasharray="2 5" />
          <line v-bind="lanes.events" class="stroke-(--art-line)" stroke-width="2" stroke-dasharray="2 5" />
          <line v-bind="lanes.posts" class="stroke-(--art-line)" stroke-width="2" stroke-dasharray="2 5" />
          <line v-bind="lanes.ws" stroke="#ff8a3d" stroke-width="2" class="fb-ws-live dash-flow opacity-0" />
          <line v-bind="lanes.wsBlocked" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 4" class="fb-ws-dead rm-show opacity-0" />
          <line v-bind="lanes.events" stroke="#ff8a3d" stroke-width="2" class="fb-events-live dash-flow rm-show opacity-0" />
          <line v-bind="lanes.posts" stroke="#ff8a3d" stroke-width="2" class="fb-posts-live dash-flow rm-show opacity-0" />
          <g v-for="label in labels" :key="label.text" :transform="label.matrix">
            <text class="font-mono text-[10px] fill-(--ui-text-muted)">{{ label.text }}</text>
          </g>

          <!-- the browser -->
          <polygon :points="client.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
          <polygon :points="client.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
          <polygon :points="client.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
          <g :transform="clientLogo">
            <image href="/logos/chrome.png" width="40" height="40" preserveAspectRatio="xMidYMid meet" />
          </g>

          <!-- the server -->
          <g v-for="(slab, index) in serverSlabs" :key="index">
            <polygon :points="slab.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
            <polygon :points="slab.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
            <polygon :points="slab.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
          </g>
          <polygon :points="serverTop.left" fill="url(#fb-edge)" stroke="#ffb36b" stroke-linejoin="round" />
          <polygon :points="serverTop.right" fill="#b83500" stroke="#ff8a3d" stroke-linejoin="round" />
          <polygon :points="serverTop.top" class="fill-zinc-950" stroke="#ff8a3d" stroke-linejoin="round" />
          <g :transform="serverLogo">
            <AppLogoMark width="48" height="66" />
          </g>

          <!-- packets -->
          <circle class="fb-handshake opacity-0" r="5" fill="#ffb36b" :cx="p(START, LANE.ws)[0]" :cy="p(START, LANE.ws)[1]" />
          <circle class="fb-burst opacity-0" fill="none" stroke="#ef4444" stroke-width="2" :cx="hit[0]" :cy="hit[1]" r="6" />
          <circle class="fb-open opacity-0" r="5" fill="none" stroke="#ffb36b" stroke-width="2" :cx="p(START, LANE.events)[0]" :cy="p(START, LANE.events)[1]" />
          <circle v-for="index in EVENTS" :key="`event-${index}`" class="fb-event opacity-0" r="4" fill="#ffb36b" :cx="p(END, LANE.events)[0]" :cy="p(END, LANE.events)[1]" />
          <template v-for="batch in 2" :key="`batch-${batch}`">
            <circle
              v-for="index in BATCH" :key="`dot-${index}`"
              :class="`fb-post-${batch - 1}`" class="opacity-0"
              r="3.5" fill="#ff8a3d" :cx="p(START, LANE.posts)[0]" :cy="p(START, LANE.posts)[1]"
            />
          </template>

          <!-- the proxy wall, over the WebSocket lane -->
          <g class="fb-wall rm-show opacity-0">
            <polygon :points="wall.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
            <polygon :points="wall.right" class="fill-(--art-right) stroke-red-400/60" stroke-linejoin="round" />
            <polygon :points="wall.right" fill="url(#fb-hazard)" />
            <polygon :points="wall.right" fill="#ef4444" class="fb-flash opacity-0" />
            <polygon :points="wall.top" class="fill-(--art-top) stroke-red-400/60" stroke-linejoin="round" />
          </g>
          <g class="fb-error rm-show opacity-0 font-mono">
            <text :x="errorAt[0]" :y="errorAt[1]" text-anchor="middle" fill="#ef4444" class="text-[13px] font-semibold">1006</text>
            <text :x="errorAt[0]" :y="errorAt[1] - 16" text-anchor="middle" class="text-[10px] fill-(--ui-text-muted)">proxy</text>
          </g>

          <!-- what the client does, step by step -->
          <g class="font-mono text-[11px]">
            <text x="420" y="34" class="fb-step fb-step-0 rm-show opacity-0 fill-(--ui-text-muted)">1 · try websocket()</text>
            <text x="420" y="54" fill="#ef4444" class="fb-step fb-step-1 rm-show opacity-0">2 · blocked: 1006</text>
            <text x="420" y="74" class="fb-step fb-step-2 rm-show opacity-0 fill-(--ui-text-muted)">3 · move to http()</text>
            <text x="420" y="94" class="fb-step fb-step-3 rm-show opacity-0 fill-orange-600 dark:fill-orange-300">4 · live, same app code</text>
          </g>

          <!-- the app code, which never changes -->
          <foreignObject x="16" y="292" width="300" height="100">
            <div class="h-full border border-default bg-elevated/60 px-3 py-2 font-mono text-[11px] leading-[19px] text-toned">
              <div><span class="text-highlighted">connect</span>(url, {</div>
              <div class="whitespace-nowrap">
                &nbsp;&nbsp;transports: [<span class="relative">websocket()<span class="fb-ws-on absolute inset-0 bg-orange-500/20 text-orange-600 opacity-0 dark:text-orange-200">websocket()</span><span class="fb-ws-strike absolute inset-x-0 top-1/2 h-px origin-left bg-red-500 rm-show opacity-0" /></span>, <span class="relative">http()<span class="fb-http-on absolute inset-0 bg-orange-500/20 text-orange-600 rm-show opacity-0 dark:text-orange-200">http()</span></span>],
              </div>
              <div>})</div>
              <div class="fb-ws-note mt-1 text-dimmed rm-show opacity-0">// blocked here, so it runs on http()</div>
            </div>
          </foreignObject>
        </svg>
      </div>
    </template>
  </LandingFeatureCell>
</template>
