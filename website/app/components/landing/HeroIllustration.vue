<script setup lang="ts">
import { createTimeline } from 'animejs'

const O = { ox: 320, oy: 330 }
const HUB = 150

// The server: an adapter at the bottom, the engine in the middle, your app on top.
const slabs = [
  { z: 0, h: 22 },
  { z: 40, h: 22 },
].map(layer => isoBox(O, -HUB / 2, -HUB / 2, layer.z, HUB, HUB, layer.h))
const TOP_Z = 82
const TOP_H = 30
const top = isoBox(O, -HUB / 2, -HUB / 2, TOP_Z, HUB, HUB, TOP_H)
const logoMatrix = isoTopMatrix(O, -34, -46, TOP_Z + TOP_H)

// Four client platforms on the ground, one along each axis, each wired to the server.
// Logos lie flat on each tile's top face. Server runtimes share one tile and take turns.
const TILE = 64
const DIST = 250
const ICON = 40
interface TileLogo { src: string, class?: string }
const runtimes: TileLogo[] = [
  { src: '/logos/nodejs.svg' },
  { src: '/logos/deno.svg', class: 'logo-white' },
  { src: '/logos/bun.svg' },
  { src: '/logos/cloudflare.svg' },
]
const clients: { name: string, x: number, y: number, logos: TileLogo[], size?: number }[] = [
  { name: 'Browser', x: -DIST, y: 0, logos: [{ src: '/logos/chrome.png' }] },
  { name: 'iOS', x: 0, y: -DIST, logos: [{ src: '/logos/apple-black.png', class: 'dark:hidden' }, { src: '/logos/apple-white.png', class: 'hidden dark:inline' }] },
  { name: 'A server runtime', x: DIST, y: 0, logos: runtimes },
  { name: 'Android', x: 0, y: DIST, logos: [{ src: '/logos/android.svg' }] },
]
const RUNTIME_TILE = 2
const placed = clients.map((client) => {
  const size = client.size ?? ICON
  const unitX = Math.sign(client.x)
  const unitY = Math.sign(client.y)
  const from = iso(O, client.x - unitX * TILE / 2, client.y - unitY * TILE / 2)
  const to = iso(O, unitX * HUB / 2, unitY * HUB / 2)
  return {
    ...client,
    faces: isoBox(O, client.x - TILE / 2, client.y - TILE / 2, 0, TILE, TILE, 12),
    logoMatrix: isoTopMatrix(O, client.x - size / 2, client.y - size / 2, 12),
    size,
    from,
    to,
  }
})

const root = ref<SVGElement>()

useIllustration(root, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutSine' } })
  timeline.add('.hub-top', { translateY: [0, -6, 0], duration: 4000 }, 0)

  const turn = 5400 / runtimes.length
  runtimes.forEach((_, index) => {
    timeline.add(`.runtime-${index}`, { opacity: [0, 1, 1, 0], duration: turn + 300, ease: 'linear' }, index * turn - (index ? 150 : 0))
  })
  return timeline
})
</script>

<template>
  <svg ref="root" viewBox="0 0 640 560" class="w-full h-auto" role="img" aria-label="A browser, an iOS app, a server runtime and an Android app connected to one LiveThing server, with messages flowing into it">
    <defs>
      <linearGradient id="hero-edge" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#ffb36b" />
        <stop offset="1" stop-color="#e14300" />
      </linearGradient>
    </defs>

    <!-- wires sit under the server, so the back wires tuck behind it -->
    <line
      v-for="client in placed"
      :key="`wire-${client.name}`"
      :x1="client.from[0]" :y1="client.from[1]" :x2="client.to[0]" :y2="client.to[1]"
      stroke="#ff8a3d" stroke-width="2" class="dash-flow"
    />

    <g v-for="(client, index) in placed" :key="`tile-${client.name}`">
      <title>{{ client.name }}</title>
      <polygon :points="client.faces.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="client.faces.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="client.faces.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
      <g :transform="client.logoMatrix">
        <g
          v-for="(logo, logoIndex) in client.logos"
          :key="logo.src"
          :class="index === RUNTIME_TILE && [`runtime-${logoIndex}`, logoIndex ? 'opacity-0' : '']"
        >
          <image :href="logo.src" :width="client.size" :height="client.size" preserveAspectRatio="xMidYMid meet" :class="logo.class" />
        </g>
      </g>
    </g>


    <g v-for="(slab, index) in slabs" :key="index">
      <polygon :points="slab.left" class="fill-(--art-left) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="slab.right" class="fill-(--art-right) stroke-(--art-line)" stroke-linejoin="round" />
      <polygon :points="slab.top" class="fill-(--art-top) stroke-(--art-line)" stroke-linejoin="round" />
    </g>
    <g class="hub-top">
      <polygon :points="top.left" fill="url(#hero-edge)" stroke="#ffb36b" stroke-linejoin="round" />
      <polygon :points="top.right" fill="#b83500" stroke="#ff8a3d" stroke-linejoin="round" />
      <polygon :points="top.top" class="fill-zinc-950" stroke="#ff8a3d" stroke-linejoin="round" />
      <g :transform="logoMatrix">
        <AppLogoMark width="68" height="94" />
      </g>
    </g>
  </svg>
</template>
