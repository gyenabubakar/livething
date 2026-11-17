<script setup lang="ts">
import { createTimeline } from 'animejs'

// The whole idea in one picture: one stream down (server-sent events), one stream up (a POST
// whose body stays open), both inside one HTTP/2 connection, drawn as a see-through tube.
const O = { ox: 336, oy: 172 }
const BROWSER = { x: -210, w: 56 }
const SERVER = { x: 116, w: 96 }
const DEPTH = 104
const START = BROWSER.x + BROWSER.w
const END = SERVER.x
const TUBE = { y: -38, d: 76, h: 20 }
const TILE_H = 28
const LANE = { down: -19, up: 19 }
const CUBE = 9
const PACKETS = 4
const TRAVEL = END - START - CUBE
const COS = Math.cos(Math.PI / 6)

const p = (x: number, y: number, z = 0) => iso(O, x, y, z)
const browser = isoBox(O, BROWSER.x, -DEPTH / 2, 0, BROWSER.w, DEPTH, TILE_H)
const browserLogo = isoTopMatrix(O, BROWSER.x + BROWSER.w / 2 - 18, -18, TILE_H)
const serverSlabs = [0, 30].map((z) => isoBox(O, SERVER.x, -DEPTH / 2, z, SERVER.w, DEPTH, 18))
const serverTop = isoBox(O, SERVER.x, -DEPTH / 2, 60, SERVER.w, DEPTH, 22)
const serverLogo = isoTopMatrix(O, SERVER.x + SERVER.w / 2 - 20, -28, 82)
const tube = isoBox(O, START, TUBE.y, 0, END - START, TUBE.d, TUBE.h)
const floor = isoBox(O, START, TUBE.y, 0, END - START, TUBE.d, 0).top

const lane = (y: number) => {
  const [x1, y1] = p(START, y)
  const [x2, y2] = p(END, y)
  return { x1, y1, x2, y2 }
}
// The lane names lie on the ground beside the tube. The tube's name floats above it.
const labels = [
  { text: '← GET · server-sent events', y: TUBE.y - 6, tone: 'fill-orange-600 dark:fill-orange-300' },
  { text: 'POST · its body stays open →', y: TUBE.y + TUBE.d + 16, tone: 'fill-sky-600 dark:fill-sky-300' },
].map((label) => ({ ...label, matrix: isoTopMatrix(O, START + 24, label.y, 0) }))
const MIDDLE = (START + END) / 2
const [nameX, nameY] = p(MIDDLE, TUBE.y, TUBE.h + 76)
const [pinX, pinY] = p(MIDDLE, TUBE.y, TUBE.h)

// Down cubes start at the server end, up cubes at the browser end.
const cube = (x: number, y: number) => isoBox(O, x, y - CUBE / 2, 0, CUBE, CUBE, CUBE)
const downCube = cube(END - CUBE, LANE.down)
const upCube = cube(START, LANE.up)
// The screen offset of a move along world x.
const along = (distance: number) => ({ x: distance * COS, y: distance / 2 })
const still = [0.2, 0.55, 0.85]

const paused = ref(false)
const art = ref<SVGElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false })
  const DURATION = 3200
  for (let index = 0; index < PACKETS; index++) {
    const at = index * (DURATION / PACKETS)
    timeline
      .add(`.ov-down-${index}`, { translateX: [0, along(-TRAVEL).x], translateY: [0, along(-TRAVEL).y], opacity: [0, 1, 1, 1, 0], duration: DURATION, ease: 'linear' }, at)
      .add(`.ov-up-${index}`, { translateX: [0, along(TRAVEL).x], translateY: [0, along(TRAVEL).y], opacity: [0, 1, 1, 1, 0], duration: DURATION, ease: 'linear' }, at + 400)
  }
  return timeline
}, { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="A Split Stream: events come down on a server-sent events stream, and messages go up in the body of one POST that stays open. On HTTP/2, both are inside one connection.">
    <svg ref="art" viewBox="0 0 680 336" class="w-full" role="img" aria-label="A browser and a LiveThing server joined by one HTTP/2 connection. Inside it, server-sent events flow from the server to the browser, and messages flow from the browser to the server in the body of one long POST request.">
      <defs>
        <linearGradient id="ov-edge" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#ffb36b" />
          <stop offset="1" stop-color="#e14300" />
        </linearGradient>
      </defs>

      <!-- the tube's floor, its two lanes, and their names lying flat -->
      <polygon :points="floor" class="fill-orange-500/[0.05] stroke-(--art-line)" />
      <line v-bind="lane(LANE.down)" stroke="#ff8a3d" stroke-width="2" class="dash-flow opacity-70" style="animation-direction: reverse" />
      <line v-bind="lane(LANE.up)" stroke="#38bdf8" stroke-width="2" class="dash-flow opacity-70" />
      <g v-for="label in labels" :key="label.text" :transform="label.matrix">
        <text class="font-mono text-[10px]" :class="label.tone">{{ label.text }}</text>
      </g>

      <!-- the browser -->
      <polygon :points="browser.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="browser.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="browser.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
      <g :transform="browserLogo">
        <image href="/logos/chrome.png" width="36" height="36" preserveAspectRatio="xMidYMid meet" />
      </g>

      <!-- packets: orange cubes down, sky cubes up -->
      <g v-for="index in PACKETS" :key="`down-${index}`" :class="`ov-down-${index - 1}`" class="ss-glow-down opacity-0">
        <polygon :points="downCube.left" fill="#c2410c" />
        <polygon :points="downCube.right" fill="#ea580c" />
        <polygon :points="downCube.top" fill="#ffb36b" />
      </g>
      <g v-for="index in PACKETS" :key="`up-${index}`" :class="`ov-up-${index - 1}`" class="ss-glow-up opacity-0">
        <polygon :points="upCube.left" fill="#0369a1" />
        <polygon :points="upCube.right" fill="#0284c7" />
        <polygon :points="upCube.top" fill="#7dd3fc" />
      </g>
      <g class="hidden motion-reduce:inline">
        <g v-for="at in still" :key="at">
          <g :transform="`translate(${along(-TRAVEL * at).x} ${along(-TRAVEL * at).y})`" class="ss-glow-down">
            <polygon :points="downCube.left" fill="#c2410c" />
            <polygon :points="downCube.right" fill="#ea580c" />
            <polygon :points="downCube.top" fill="#ffb36b" />
          </g>
          <g :transform="`translate(${along(TRAVEL * at).x} ${along(TRAVEL * at).y})`" class="ss-glow-up">
            <polygon :points="upCube.left" fill="#0369a1" />
            <polygon :points="upCube.right" fill="#0284c7" />
            <polygon :points="upCube.top" fill="#7dd3fc" />
          </g>
        </g>
      </g>

      <!-- the one connection, see-through, around both lanes -->
      <polygon :points="tube.left" class="fill-orange-500/[0.06] stroke-orange-400/50" stroke-linejoin="round" />
      <polygon :points="tube.top" class="fill-orange-500/[0.03] stroke-orange-400/50" stroke-linejoin="round" stroke-dasharray="4 4" />
      <line :x1="pinX" :y1="pinY" :x2="nameX" :y2="nameY + 6" class="stroke-orange-400/60" stroke-dasharray="2 3" />
      <circle :cx="pinX" :cy="pinY" r="2.5" fill="#ff8a3d" />
      <text :x="nameX" :y="nameY" text-anchor="middle" class="font-mono text-[11px] uppercase tracking-widest fill-orange-700 dark:fill-orange-200">one HTTP/2 connection</text>

      <!-- the server -->
      <g v-for="(slab, index) in serverSlabs" :key="index">
        <polygon :points="slab.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
        <polygon :points="slab.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
        <polygon :points="slab.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
      </g>
      <polygon :points="serverTop.left" fill="url(#ov-edge)" stroke="#ffb36b" stroke-linejoin="round" />
      <polygon :points="serverTop.right" fill="#b83500" stroke="#ff8a3d" stroke-linejoin="round" />
      <polygon :points="serverTop.top" class="fill-zinc-950" stroke="#ff8a3d" stroke-linejoin="round" />
      <g :transform="serverLogo">
        <AppLogoMark width="40" height="56" />
      </g>

      <text :x="p(BROWSER.x + BROWSER.w / 2, DEPTH / 2)[0]" :y="p(BROWSER.x + BROWSER.w / 2, DEPTH / 2)[1] + 24" text-anchor="middle" class="font-mono text-[11px] fill-(--ui-text-muted)">browser</text>
      <text :x="p(SERVER.x + SERVER.w / 2, DEPTH / 2)[0]" :y="p(SERVER.x + SERVER.w / 2, DEPTH / 2)[1] + 24" text-anchor="middle" class="font-mono text-[11px] fill-(--ui-text-muted)">LiveThing server</text>
    </svg>
  </SplitStreamFigure>
</template>
