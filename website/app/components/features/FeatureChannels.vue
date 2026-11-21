<script setup lang="ts">
import { createTimeline } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

const GATE = { x: 300, y: 160 }
const joiners = [
  { name: 'ama', y: 80, seat: { x: 400, y: 115 }, allowed: true },
  { name: 'kofi', y: 160, seat: { x: 440, y: 205 }, allowed: true },
  { name: 'guest', y: 240, seat: null, allowed: false },
]
const START_X = 96

const art = ref<SVGElement>()

useIllustration(art, () => {
  const timeline = createTimeline({ loop: true, autoplay: false, defaults: { ease: 'inOutQuad' } })
  joiners.forEach((joiner, index) => {
    const dot = `.ch-dot-${index}`
    const at = index * 1500
    timeline
      .add(dot, { translateX: GATE.x - START_X - 12, translateY: GATE.y - joiner.y, duration: 900 }, at)
      .add(joiner.allowed ? '.ch-gate-ok' : '.ch-gate-no', { opacity: [0, 1, 0], duration: 700 }, at + 900)
    if (joiner.seat) {
      timeline.add(dot, { translateX: joiner.seat.x - START_X, translateY: joiner.seat.y - joiner.y, duration: 700 }, at + 1100)
    }
    else {
      timeline
        .add(dot, { translateX: 0, translateY: 0, duration: 800, ease: 'outBack' }, at + 1100)
        .add('.ch-denied', { opacity: [0, 1], duration: 300 }, at + 1500)
    }
  })
  return timeline
    .add('.ch-ring', { r: [10, 120], opacity: [0.8, 0], duration: 1200, ease: 'outQuad' }, 5200)
    .add('.ch-member', { scale: [1, 1.6, 1], duration: 500, delay: (_: unknown, i: number) => i * 80 }, 5500)
    .add('.ch-label', { opacity: [0, 1, 1, 0], duration: 2000 }, 5200)
    .add(joiners.map((_, i) => `.ch-dot-${i}`), { translateX: 0, translateY: 0, opacity: [1, 0, 1], duration: 900 }, 8000)
    .add('.ch-denied', { opacity: 0, duration: 300 }, 8000)
})
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div class="absolute inset-0 bg-[linear-gradient(var(--art-grid)_1px,transparent_1px),linear-gradient(90deg,var(--art-grid)_1px,transparent_1px)] bg-size-[16px_16px]" aria-hidden="true" />
      <svg ref="art" viewBox="0 0 560 320" class="art-origin absolute inset-0 size-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Two clients pass the room's check and join, a third is refused, then a broadcast reaches only the members">
        <g v-for="joiner in joiners" :key="joiner.name" class="font-mono text-[11px]">
          <line :x1="START_X" :y1="joiner.y" :x2="GATE.x - 12" :y2="GATE.y" class="stroke-(--art-line)" stroke-dasharray="2 4" />
          <text :x="START_X - 16" :y="joiner.y + 4" text-anchor="end" class="fill-(--ui-text-muted)">{{ joiner.name }}</text>
        </g>
        <text :x="START_X - 16" y="262" text-anchor="end" class="ch-denied font-mono text-[10px] fill-red-400 opacity-0">denied</text>

        <rect :x="GATE.x" y="60" width="220" height="200" class="fill-orange-500/[0.04] stroke-orange-400/40" />
        <text :x="GATE.x + 14" y="82" class="font-mono text-[11px] fill-orange-600 dark:fill-orange-300">room:general</text>
        <circle class="ch-ring opacity-0 fill-none stroke-orange-400" :cx="GATE.x + 110" cy="160" r="10" />
        <text class="ch-label font-mono text-[10px] fill-orange-600 dark:fill-orange-200 opacity-0" :x="GATE.x + 14" y="248">broadcast → members only</text>

        <g class="ch-member">
          <circle :cx="GATE.x + 170" cy="130" r="6" class="fill-orange-400" />
        </g>
        <text :x="GATE.x + 182" y="134" class="font-mono text-[10px] fill-(--ui-text-dimmed)">ada</text>

        <rect :x="GATE.x - 12" :y="GATE.y - 22" width="24" height="44" class="fill-(--ui-bg) stroke-(--art-line)" />
        <rect :x="GATE.x - 12" :y="GATE.y - 22" width="24" height="44" class="ch-gate-ok fill-emerald-500/40 stroke-emerald-300 opacity-0" />
        <rect :x="GATE.x - 12" :y="GATE.y - 22" width="24" height="44" class="ch-gate-no fill-red-500/40 stroke-red-300 opacity-0" />
        <text :x="GATE.x" :y="GATE.y + 38" text-anchor="middle" class="font-mono text-[10px] fill-(--ui-text-muted)">join rule</text>

        <g v-for="(joiner, index) in joiners" :key="`dot-${joiner.name}`" :class="[`ch-dot-${index}`, joiner.allowed && 'ch-member']">
          <circle :cx="START_X" :cy="joiner.y" r="6" :class="joiner.allowed ? 'fill-orange-400' : 'fill-zinc-400'" />
        </g>
      </svg>
    </template>
  </LandingFeatureCell>
</template>
