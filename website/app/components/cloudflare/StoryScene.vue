<script setup lang="ts">
// The scene behind the "how it works" story. `step` picks what is lit: people
// connect at the edge, the Worker routes to the room, the room sleeps, a
// message wakes it, and a mention reaches someone who is offline.
const props = defineProps<{ step: number }>()

const people = [
  { name: 'amara', city: 'Accra' },
  { name: 'kofi', city: 'London' },
  { name: 'ben', city: 'São Paulo' },
  { name: 'yaa', city: 'Tokyo' },
].map((person, index) => ({ ...person, x: 36 + index * 132, cx: 82 + index * 132 }))

const DEVICE = { y: 24, w: 92, h: 46 }
const EDGE = { x: 20, y: 140, w: 520, h: 44 }
const WORKER = { x: 170, y: 232, w: 220, h: 44 }
const ROOM = { x: 160, y: 330, w: 240, h: 150 }
const SIDE = { y: 350, w: 110, h: 60 }
const MID = (DEVICE.y + DEVICE.h + EDGE.y) / 2

const routed = computed(() => props.step >= 1)
const sleeping = computed(() => props.step === 2)
const woken = computed(() => props.step === 3)
const reaching = computed(() => props.step === 4)
const amaraOffline = computed(() => props.step === 4)
</script>

<template>
  <svg viewBox="0 0 560 500" class="h-auto w-full cursor-default select-none" role="img" aria-label="People connect to nearby Cloudflare cities, a Worker routes them to one room, and the room is a Durable Object with its sockets, SQLite storage and alarm">
    <!-- people and their devices -->
    <g v-for="(person, index) in people" :key="person.name">
      <g class="scene-fade" :class="index === 0 && amaraOffline && 'opacity-45'">
        <rect :x="person.x" :y="DEVICE.y" :width="DEVICE.w" :height="DEVICE.h" class="fill-(--art-top) stroke-(--art-line)" />
        <rect :x="person.x + 10" :y="DEVICE.y + 12" width="22" height="22" class="fill-orange-500/15 stroke-orange-400/50" />
        <text :x="person.x + 21" :y="DEVICE.y + 27" text-anchor="middle" class="text-[11px] font-semibold fill-orange-600 dark:fill-orange-300">{{ person.name[0]!.toUpperCase() }}</text>
        <text :x="person.x + 40" :y="DEVICE.y + 22" class="text-[12px] font-medium fill-(--ui-text-highlighted)">{{ person.name }}</text>
        <text :x="person.x + 40" :y="DEVICE.y + 36" class="font-mono text-[9px] fill-(--ui-text-muted)">{{ index === 0 && amaraOffline ? 'offline' : 'online' }}</text>
      </g>

      <!-- the socket from the device to its nearest city -->
      <line
        :x1="person.cx" :y1="DEVICE.y + DEVICE.h" :x2="person.cx" :y2="EDGE.y"
        stroke="#ff8a3d" stroke-width="2"
        class="dash-flow scene-fade"
        :class="index === 0 && amaraOffline && 'opacity-0'"
      />
    </g>

    <!-- the Cloudflare network -->
    <rect :x="EDGE.x" :y="EDGE.y" :width="EDGE.w" :height="EDGE.h" class="fill-(--art-top) stroke-(--art-line)" />
    <g v-for="person in people" :key="`city-${person.name}`">
      <rect :x="person.cx - 3" :y="EDGE.y - 3" width="6" height="6" fill="#ff8a3d" />
      <text :x="person.cx" :y="EDGE.y + 27" text-anchor="middle" class="text-[11px] fill-(--ui-text-toned)">{{ person.city }}</text>
    </g>
    <image href="/logos/cloudflare.svg" :x="EDGE.x + EDGE.w - 36" :y="EDGE.y + EDGE.h + 26" width="36" height="18" preserveAspectRatio="xMidYMid meet" />
    <text :x="EDGE.x + EDGE.w - 42" :y="EDGE.y + EDGE.h + 39" text-anchor="end" class="text-[10px] font-medium uppercase tracking-widest fill-zinc-500">348 cities</text>

    <!-- chips riding on the sockets -->
    <g v-for="(person, index) in people" :key="`chip-${person.name}`">
      <g class="scene-fade" :class="sleeping ? 'opacity-100' : 'opacity-0'">
        <rect :x="person.cx - 36" :y="MID - 10" width="72" height="20" class="fill-(--ui-bg) stroke-(--art-line)" />
        <text :x="person.cx" :y="MID + 4" text-anchor="middle" class="font-mono text-[10px] fill-(--ui-text-muted)">ping · pong</text>
      </g>
      <g class="scene-fade" :class="woken ? 'opacity-100' : 'opacity-0'">
        <rect :x="person.cx - 44" :y="MID - 10" width="88" height="20" :class="index === 1 ? 'fill-orange-500' : 'fill-(--ui-bg) stroke-orange-400/70'" />
        <text :x="person.cx" :y="MID + 4" text-anchor="middle" class="font-mono text-[10px]" :class="index === 1 ? 'fill-zinc-950' : 'fill-orange-600 dark:fill-orange-300'">{{ index === 1 ? 'send-message' : 'message' }}</text>
      </g>
    </g>

    <!-- the Worker picks the room by name -->
    <g class="scene-fade" :class="routed ? 'opacity-100' : 'opacity-20'">
      <line
        v-for="person in people" :key="`route-${person.name}`"
        :x1="person.cx" :y1="EDGE.y + EDGE.h" :x2="WORKER.x + WORKER.w / 2" :y2="WORKER.y"
        stroke="#ff8a3d" stroke-width="1.5" class="dash-flow opacity-60"
      />
      <rect :x="WORKER.x" :y="WORKER.y" :width="WORKER.w" :height="WORKER.h" class="fill-(--art-top) stroke-(--art-line)" />
      <text :x="WORKER.x + 14" :y="WORKER.y + 18" class="text-[11px] font-medium fill-(--ui-text-highlighted)">worker.ts</text>
      <text :x="WORKER.x + 14" :y="WORKER.y + 34" class="font-mono text-[10px] fill-orange-600 dark:fill-orange-300">idFromName('room:launch')</text>
      <line :x1="WORKER.x + WORKER.w / 2" :y1="WORKER.y + WORKER.h" :x2="WORKER.x + WORKER.w / 2" :y2="ROOM.y" stroke="#ff8a3d" stroke-width="2" class="dash-flow" />
    </g>

    <!-- the room: one Durable Object with its sockets, storage and alarm -->
    <g class="scene-fade" :class="[routed ? 'opacity-100' : 'opacity-20', sleeping && 'opacity-50!']">
      <rect :x="ROOM.x" :y="ROOM.y" :width="ROOM.w" :height="ROOM.h" class="scene-fade fill-(--art-top)" :class="woken || reaching ? 'stroke-orange-400' : 'stroke-(--art-line)'" stroke-width="1.5" />
      <text :x="ROOM.x + 16" :y="ROOM.y + 26" class="font-mono text-[13px] font-medium fill-(--ui-text-highlighted)">room:launch</text>
      <text :x="ROOM.x + ROOM.w - 16" :y="ROOM.y + 26" text-anchor="end" class="text-[9px] font-medium uppercase tracking-widest fill-zinc-500">Durable Object</text>
      <g v-for="(chip, index) in ['4 sockets', 'SQLite', 'alarm']" :key="chip">
        <rect :x="ROOM.x + 16 + index * 72" :y="ROOM.y + 44" width="64" height="26" class="fill-orange-500/[0.07] stroke-orange-400/30" />
        <text :x="ROOM.x + 48 + index * 72" :y="ROOM.y + 61" text-anchor="middle" class="font-mono text-[10px] fill-(--ui-text-muted)">{{ chip }}</text>
      </g>
      <rect :x="ROOM.x + 16" :y="ROOM.y + 96" width="7" height="7" :class="sleeping ? 'fill-zinc-400' : 'fill-orange-500'" />
      <text :x="ROOM.x + 32" :y="ROOM.y + 103" class="text-[12px] fill-(--ui-text-toned)">
        {{ sleeping ? 'hibernating, out of memory' : woken ? 'woke up and restored 4 members' : 'awake' }}
      </text>
      <text :x="ROOM.x + 32" :y="ROOM.y + 124" class="font-mono text-[10px] fill-(--ui-text-muted)">
        {{ sleeping ? '$0 for idle time' : woken ? 'stored · sent to 3 · inboxed' : reaching ? 'mention → user:amara' : 'one copy, worldwide' }}
      </text>
    </g>

    <!-- other objects: another room, and Amara's own object -->
    <g class="scene-fade" :class="routed ? 'opacity-100' : 'opacity-20'">
      <g :class="reaching ? 'opacity-100' : 'opacity-50'" class="scene-fade">
        <rect :x="EDGE.x" :y="SIDE.y" :width="SIDE.w" :height="SIDE.h" class="scene-fade fill-(--art-top)" :class="reaching ? 'stroke-orange-400' : 'stroke-(--art-line)'" stroke-width="1.5" />
        <text :x="EDGE.x + 12" :y="SIDE.y + 24" class="font-mono text-[11px] fill-(--ui-text-highlighted)">user:amara</text>
        <text :x="EDGE.x + 12" :y="SIDE.y + 44" class="text-[10px] fill-(--ui-text-muted)">feed · push</text>
      </g>
      <g class="opacity-50">
        <rect :x="EDGE.x + EDGE.w - SIDE.w" :y="SIDE.y" :width="SIDE.w" :height="SIDE.h" class="fill-(--art-top) stroke-(--art-line)" />
        <text :x="EDGE.x + EDGE.w - SIDE.w + 12" :y="SIDE.y + 24" class="font-mono text-[11px] fill-(--ui-text-highlighted)">doc:roadmap</text>
        <text :x="EDGE.x + EDGE.w - SIDE.w + 12" :y="SIDE.y + 44" class="text-[10px] fill-(--ui-text-muted)">another room</text>
      </g>
    </g>

    <!-- a mention travels to Amara's object, then out as a push notification -->
    <g class="scene-fade" :class="reaching ? 'opacity-100' : 'opacity-0'">
      <line :x1="ROOM.x" :y1="SIDE.y + SIDE.h / 2" :x2="EDGE.x + SIDE.w" :y2="SIDE.y + SIDE.h / 2" stroke="#ff8a3d" stroke-width="2" class="dash-flow" style="animation-direction: reverse" />
      <line :x1="EDGE.x + 30" :y1="SIDE.y" :x2="EDGE.x + 30" :y2="DEVICE.y + DEVICE.h + 20" stroke="#ff8a3d" stroke-width="2" class="dash-flow" style="animation-direction: reverse" />
      <rect :x="EDGE.x + 2" :y="DEVICE.y + DEVICE.h + 20" width="118" height="30" class="fill-zinc-950 stroke-orange-400" />
      <text :x="EDGE.x + 12" :y="DEVICE.y + DEVICE.h + 33" class="text-[9px] fill-orange-300">push notification</text>
      <text :x="EDGE.x + 12" :y="DEVICE.y + DEVICE.h + 44" class="text-[9px] fill-zinc-200">kofi mentioned you</text>
    </g>
  </svg>
</template>

<style scoped>
.scene-fade {
  transition: opacity 0.5s ease, stroke 0.5s ease;
}
</style>
